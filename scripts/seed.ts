import { createHash } from "node:crypto";
import { loadEnv } from "./env";
import { getScenario, type PartDefinition, type PartId, type ScenarioId } from "../src/lib/assembly";
import { postgres } from "../src/lib/db/postgres";
import { clickhouse, insertSpatialEvents, type SpatialEventRow } from "../src/lib/db/clickhouse";
import { errorMessage } from "../src/lib/db/tls";

loadEnv();

// ~30 simulated runs across 10 operators with realistic mistake patterns, so the Critic has history to learn from.
// Deterministic: rerunning replaces the same seeded sessions instead of duplicating them.
const RUNS_PER_OPERATOR = 3;
const OPERATORS = Array.from({ length: 10 }, (_, digit) => String(digit));
const DAG_VERSION = "1.0";
// 6 of 10 operators habitually reach for the gland nut before the spool; 4 fit the actuator cap at the wrong rotation.
const GLAND_FIRST = new Set(["1", "2", "4", "5", "7", "9"]);
const CAP_ROTATION = new Set(["0", "3", "5", "8"]);

let state = 0x5f0f1e;
const random = () => { state = (state + 0x6d2b79f5) | 0; let t = Math.imul(state ^ (state >>> 15), 1 | state); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const chance = (p: number) => random() < p;
const between = (min: number, max: number) => Math.round(min + random() * (max - min));
const seedUuid = (index: number) => { const h = createHash("sha256").update(`spatialforge-seed-run-${index}`).digest("hex"); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`; };
const wrongRotation = (part: PartDefinition) => [0, 90, 180, 270].filter((value) => value !== part.requiredRotation)[between(0, 2)];

type Run = { id: string; operator: string; scenario: ScenarioId; mode: "workbench" | "camera"; startedAt: Date; completedAt: Date; rows: SpatialEventRow[]; corrections: number; placements: Array<{ scenario: ScenarioId; partId: PartId; targetId: PartId; rotation: number; method: "gesture" | "touch"; at: string }> };

function simulate(index: number, operator: string, attempt: number, scenario: ScenarioId): Run {
  const id = seedUuid(index);
  const mode = chance(0.35) ? "camera" : "workbench";
  const method = mode === "camera" ? "gesture" : "touch";
  const source = mode === "camera" ? "gesture" : "touch";
  const startedAt = new Date(Date.now() - (30 - index) * 5.5 * 3600_000 - between(0, 3600_000));
  let clock = startedAt.getTime();
  let sequence = 0;
  let corrections = 0;
  const rows: SpatialEventRow[] = [];
  const placements: Run["placements"] = [];
  const learning = attempt === 0 ? 1 : 0.55; // operators repeat habits less on later runs
  const emit = (type: string, gapMs: number, extra: { partId?: string; targetId?: string; rotation?: number | null; payload?: Record<string, unknown> } = {}) => {
    clock += gapMs;
    const at = new Date(clock).toISOString();
    rows.push({ session_id: id, sequence: ++sequence, event_type: type, scenario_id: scenario, operator_code: operator, dag_version: DAG_VERSION, mode, source: type === "session_started" || type === "session_completed" ? "system" : source, part_id: extra.partId ?? "", target_id: extra.targetId ?? "", rotation: extra.rotation ?? null, payload: JSON.stringify({ seeded: true, ...extra.payload }), at });
    return at;
  };
  emit("session_started", 0, { payload: { capabilities: { seeded: true, camera: mode === "camera" } } });
  const parts = getScenario(scenario).parts;
  parts.forEach((part, position) => {
    const next = parts[position + 1];
    // Out-of-order reach: gland nut before spool (valve) or gland before spring (pneumatic).
    const glandHabit = GLAND_FIRST.has(operator) ? 0.85 * learning : 0.12;
    if (next && ((scenario === "valve" && part.id === "V2") || (scenario === "pneumatic" && part.id === "P4")) && chance(glandHabit)) {
      emit("out_of_sequence_pick", between(2500, 6000), { partId: next.id, payload: { attemptedPartId: next.id, requiredPartId: part.id } }); corrections++;
    }
    emit("pickup_started", between(1200, 4500), { partId: part.id, payload: { partId: part.id } });
    if (mode === "camera" && chance(0.1)) { emit("tracking-lost", between(800, 2500), { partId: part.id }); corrections++; }
    if (chance(0.1)) { // wrong slot on release
      const others = parts.filter((candidate) => candidate.id !== part.id);
      const wrong = others[between(0, others.length - 1)].target;
      emit("placement_rejected", between(1500, 4000), { partId: part.id, targetId: wrong, payload: { target: wrong, reason: "wrong-target", method } });
      emit("wrong-target", 5, { partId: part.id, targetId: wrong, payload: { attemptedTarget: wrong } }); corrections++;
    }
    const capPart = (scenario === "valve" && part.id === "V4") || (scenario === "pneumatic" && part.id === "P6");
    const rotationMiss = part.requiredRotation !== 0 && chance(capPart ? (CAP_ROTATION.has(operator) ? 0.8 * learning : 0.15) : 0.18);
    if (rotationMiss) {
      const rotation = wrongRotation(part);
      emit("placement_rejected", between(2000, 5000), { partId: part.id, targetId: part.target, rotation, payload: { target: part.target, rotation, reason: "orientation", method } });
      emit("orientation", 5, { partId: part.id, targetId: part.target, rotation, payload: { attemptedTarget: part.target } }); corrections++;
    }
    const gap = between(2000, 6000) + (rotationMiss ? between(3000, 9000) : 0);
    emit("placement_accepted", gap, { partId: part.id, targetId: part.target, rotation: part.requiredRotation, payload: { target: part.target, rotation: part.requiredRotation, method } });
    const at = emit("placement_verified", 5, { partId: part.id, targetId: part.target, rotation: part.requiredRotation, payload: { method } });
    placements.push({ scenario, partId: part.id, targetId: part.target, rotation: part.requiredRotation, method, at });
  });
  emit("session_completed", between(500, 1500), { payload: { corrections } });
  return { id, operator, scenario, mode, startedAt, completedAt: new Date(clock), rows, corrections, placements };
}

async function main() {
  const runs: Run[] = [];
  OPERATORS.forEach((operator, o) => { for (let attempt = 0; attempt < RUNS_PER_OPERATOR; attempt++) runs.push(simulate(o * RUNS_PER_OPERATOR + attempt, operator, attempt, attempt === 2 && o % 2 === 0 ? "pneumatic" : "valve")); });
  runs.sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
  const ids = runs.map((run) => run.id);
  const dryRun = process.argv.includes("--dry-run");
  const pg = dryRun ? null : postgres();
  const ch = dryRun ? null : clickhouse();
  if (!pg && !ch && !dryRun) { console.error("Neither DATABASE_URL nor CLICKHOUSE_URL is set; nothing to seed."); process.exit(1); }
  let failed = false;
  if (pg) {
    const client = await pg.connect();
    try {
      await client.query("begin");
      await client.query("delete from completion_passports where session_id = any($1::uuid[])", [ids]);
      await client.query("delete from assembly_sessions where id = any($1::uuid[])", [ids]);
      for (const run of runs) {
        await client.query("insert into assembly_sessions (id, operator_code, scenario_id, mode, dag_version, capability_report, started_at, completed_at, summary) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)", [run.id, run.operator, run.scenario, run.mode, DAG_VERSION, { seeded: true }, run.startedAt, run.completedAt, { seeded: true, corrections: run.corrections, placements: run.placements.length, durationMs: run.completedAt.getTime() - run.startedAt.getTime() }]);
        const evidence = { operator: run.operator, scenario: run.scenario, dagVersion: DAG_VERSION, placements: run.placements, completedAt: run.completedAt.toISOString(), identity: "self-declared" };
        const sha256 = createHash("sha256").update(JSON.stringify(evidence)).digest("hex");
        await client.query("insert into completion_passports (operator_code, scenario_id, session_id, dag_version, evidence, sha256) values ($1,$2,$3,$4,$5,$6) on conflict (sha256) do nothing", [run.operator, run.scenario, run.id, DAG_VERSION, evidence, sha256]);
      }
      await client.query("commit");
      console.log(`postgres: ${runs.length} sessions and passports seeded`);
    } catch (error) { failed = true; await client.query("rollback").catch(() => undefined); console.error("postgres: seed failed:", errorMessage(error)); }
    finally { client.release(); await pg.end(); }
  }
  if (ch) {
    try {
      await ch.command({ query: "DELETE FROM spatial_events WHERE session_id IN {ids:Array(String)}", query_params: { ids } });
      const rows = runs.flatMap((run) => run.rows);
      await insertSpatialEvents(ch, rows);
      console.log(`clickhouse: ${rows.length} spatial events seeded`);
    } catch (error) { failed = true; console.error("clickhouse: seed failed:", errorMessage(error)); }
    finally { await ch.close(); }
  }
  const valve = runs.filter((run) => run.scenario === "valve");
  const glandFirst = valve.filter((run) => run.rows.some((row) => row.event_type === "out_of_sequence_pick")).length;
  const capRotation = valve.filter((run) => run.rows.some((row) => row.event_type === "orientation" && row.part_id === "V4")).length;
  console.log(`summary: ${runs.length} runs, ${OPERATORS.length} operators, ${valve.length} valve runs; gland nut before spool in ${glandFirst}, wrong cap rotation in ${capRotation}`);
  process.exit(failed ? 1 : 0);
}

void main();
