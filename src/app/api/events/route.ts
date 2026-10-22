import { after, NextResponse } from "next/server";
import { getOperator } from "@/lib/auth";
import { processCriticQueue } from "@/lib/agent/critic";
import { enqueueForgeCritic, runForgeCritic } from "@/lib/agent/critic-forge";
import { completeSession, forgeKey, parseForgeEvent, rememberEvents, updateShortTerm, type StoredForgeEvent } from "@/lib/forge/memory";
import { clickhouse, insertSpatialEvents, type SpatialEventRow } from "@/lib/db/clickhouse";
import { LIVE_SESSION_TTL_SECONDS, VALKEY_KEYS, valkey } from "@/lib/db/valkey";
import { errorMessage } from "@/lib/db/tls";
import { isUuid, postgres } from "@/lib/db/postgres";
import { isOperator, isScenario } from "@/lib/agent/guidance-store";
import { CORRECTION_KINDS, knownParts } from "@/lib/agent/tools";
import { DEFAULT_DAG_VERSION } from "@/lib/spatial-engine";

const MAX_BATCH = 500;
const MAX_BODY_BYTES = 512 * 1024;
const EVENT_TYPES = new Set(["session_started", "session_completed", "pickup_started", "out_of_sequence_pick", "placement_accepted", "placement_rejected", "placement_verified", "placement_removed", ...CORRECTION_KINDS]);
const text = (value: unknown, max = 120) => typeof value === "string" ? value.slice(0, max) : typeof value === "number" ? String(value) : "";
const idOrEmpty = (value: unknown) => value === undefined || value === null || value === "" ? "" : typeof value === "string" ? value : null;
type SessionRow = { id: string; operator_code: string; scenario_id: string; dag_version: string };

// Accepts both the client SpatialEvent shape (telemetry queue) and the flat store events. Returns null for anything
// that is not a known event type, scenario, and part ids of that scenario, so client text never reaches the agents.
function toRow(item: Record<string, unknown>, sessions: Map<string, SessionRow> | null): SpatialEventRow | null {
  const payload = item.payload && typeof item.payload === "object" ? item.payload as Record<string, unknown> : {};
  const type = text(item.type, 64), sessionId = text(item.sessionId, 64);
  if (!EVENT_TYPES.has(type) || !isScenario(item.scenario) || (sessionId && !isUuid(sessionId))) return null;
  const ids = [item.partId, payload.partId, payload.attemptedPartId, item.requiredPartId, payload.requiredPartId, item.targetId, item.attemptedTarget, item.prerequisite, payload.target, payload.prerequisite].map(idOrEmpty);
  if (ids.some((id) => id === null) || !knownParts(item.scenario, ...ids)) return null;
  const session = sessionId && sessions ? sessions.get(sessionId) : undefined;
  // With PostgreSQL configured, a run only counts if its session exists there, and the version comes from that row.
  if (sessions && type === "session_completed" && !session) return null;
  const rotation = typeof item.rotation === "number" ? item.rotation : typeof payload.rotation === "number" ? payload.rotation : null;
  const at = typeof item.at === "string" && !Number.isNaN(Date.parse(item.at)) ? item.at : new Date().toISOString();
  return {
    session_id: sessionId, sequence: Number.isInteger(item.sequence) && (item.sequence as number) >= 0 ? item.sequence as number : 0,
    event_type: type, scenario_id: session?.scenario_id ?? item.scenario, operator_code: session?.operator_code ?? (isOperator(item.operator ?? payload.operator) ? String(item.operator ?? payload.operator) : ""),
    dag_version: session?.dag_version ?? (text(item.dagVersion, 32) || DEFAULT_DAG_VERSION), mode: text(item.mode, 16), source: text(item.source, 16),
    part_id: text(item.partId ?? payload.partId ?? payload.attemptedPartId, 16), target_id: text(item.targetId ?? item.attemptedTarget ?? payload.target, 16),
    rotation: rotation === null || !Number.isFinite(rotation) ? null : Math.round(rotation), payload: JSON.stringify(item).slice(0, 8000), at,
  };
}

async function knownSessions(events: Record<string, unknown>[]): Promise<Map<string, SessionRow> | null> {
  const db = postgres();
  if (!db) return null;
  const ids = [...new Set(events.map((event) => event.sessionId).filter(isUuid))];
  if (!ids.length) return new Map();
  const { rows } = await db.query("select id, operator_code, scenario_id, dag_version from assembly_sessions where id = any($1::uuid[])", [ids]);
  return new Map((rows as SessionRow[]).map((row) => [String(row.id), row]));
}

// Forge events (type "forge_*") are validated with zod (memory.ts), stored with scenario_id "forge:<id>", folded into
// short-term memory, and a forge_session_completed updates the long-term profile and queues the Forge Critic.
// The operator comes from the sf_op cookie when present; otherwise the body's operatorId is kept but marked unverified.
function forgeRow(event: StoredForgeEvent): SpatialEventRow {
  const { operatorId: _operatorId, ...rest } = event;
  return {
    session_id: event.sessionId, sequence: event.sequence, event_type: event.type, scenario_id: forgeKey(event.scenarioId), operator_code: event.operatorId,
    dag_version: String(event.scenarioVersion), mode: event.mode, source: event.operatorVerified ? "forge" : "forge-unverified",
    part_id: event.partId ?? "", target_id: event.stepId ?? "", rotation: null, payload: JSON.stringify({ ...rest, operatorId: event.operatorId }).slice(0, 8000), at: event.at,
  };
}

async function afterForge(events: StoredForgeEvent[]) {
  const result = { memory: false, completed: 0, queued: 0 };
  if (!events.length) return result;
  try { await updateShortTerm(events); result.memory = true; } catch (error) { console.error("events: forge short-term memory failed", errorMessage(error)); }
  const completions = new Map(events.filter((event) => event.type === "forge_session_completed" && event.operatorId).map((event) => [event.sessionId, event]));
  for (const event of completions.values()) {
    try {
      const { counted } = await completeSession(event, events);
      if (!counted) continue;
      result.completed++;
      if (await enqueueForgeCritic({ scenarioId: event.scenarioId, version: event.scenarioVersion, operatorId: event.operatorId, sessionId: event.sessionId, completedAt: event.at })) result.queued++;
      else after(() => runForgeCritic({ scenarioId: event.scenarioId, operator: event.operatorId, sessionId: event.sessionId }).then(() => undefined));
    } catch (error) { console.error("events: forge session completion failed", errorMessage(error)); }
  }
  // The Critic runs right after the response; the admin "Run critic" button drains anything left in the queue.
  if (result.queued) after(() => processCriticQueue(result.queued).then(() => undefined).catch((error) => console.error("events: critic run failed", errorMessage(error))));
  return result;
}

export async function POST(request: Request) {
  if (Number(request.headers.get("content-length") || 0) > MAX_BODY_BYTES) return NextResponse.json({ error: "Batch too large" }, { status: 413 });
  const body = await request.json().catch(() => null) as { events?: unknown[] } | Record<string, unknown> | null;
  const all = Array.isArray((body as { events?: unknown[] } | null)?.events) ? (body as { events: unknown[] }).events : [body];
  if (!all.length || all.length > MAX_BATCH || all.some((event) => !event || typeof event !== "object" || typeof (event as { type?: unknown }).type !== "string")) return NextResponse.json({ error: "Invalid event" }, { status: 400 });
  const isForge = (event: unknown) => (event as { type: string }).type.startsWith("forge_");
  const cookieOperator = getOperator(request)?.id ?? null;
  const forgeEvents = all.filter(isForge).map((event) => parseForgeEvent(event, cookieOperator)).filter((event): event is StoredForgeEvent => Boolean(event));
  const forgeDropped = all.filter(isForge).length - forgeEvents.length;
  const events = all.filter((event) => !isForge(event));
  let sessions: Map<string, SessionRow> | null = null;
  if (events.length) {
    try { sessions = await knownSessions(events as Record<string, unknown>[]); }
    catch (error) { console.error("events: session lookup failed", errorMessage(error)); return NextResponse.json({ ok: false, error: "Session store unavailable" }, { status: 502 }); }
  }
  // Invalid events are dropped (not rejected) so a client queue holding one bad event cannot block the rest forever.
  const legacyRows = events.map((event) => toRow(event as Record<string, unknown>, sessions)).filter((row): row is SpatialEventRow => Boolean(row));
  const rows = [...legacyRows, ...forgeEvents.map(forgeRow)];
  const dropped = events.length - legacyRows.length + forgeDropped;
  if (!rows.length) return NextResponse.json({ ok: true, persisted: false, live: false, count: 0, dropped });
  const ch = clickhouse();
  if (ch) {
    try { await insertSpatialEvents(ch, rows); }
    catch (error) { console.error("events: clickhouse insert failed", errorMessage(error)); return NextResponse.json({ ok: false, error: "Event store unavailable" }, { status: 502 }); }
  } else rememberEvents(forgeEvents);
  const forge = await afterForge(forgeEvents);
  if (!legacyRows.length) return NextResponse.json({ ok: true, persisted: Boolean(ch), live: forge.memory, count: rows.length, dropped, forge: { count: forgeEvents.length, verified: Boolean(cookieOperator), completed: forge.completed, criticQueued: forge.queued } });
  // Live session state is best effort: a Valkey outage must not drop events that already reached ClickHouse.
  const cache = valkey();
  let live = false;
  if (cache) {
    try {
      const latest = new Map<string, SpatialEventRow>();
      const counts = new Map<string, number>();
      for (const row of legacyRows) if (row.session_id) { latest.set(row.session_id, row); counts.set(row.session_id, (counts.get(row.session_id) || 0) + 1); }
      if (latest.size) {
        const pipeline = cache.multi();
        for (const [id, row] of latest) {
          const key = VALKEY_KEYS.session(id);
          pipeline.hset(key, { lastEventType: row.event_type, lastEventAt: row.at, lastSequence: String(row.sequence), operator: row.operator_code, scenario: row.scenario_id, dagVersion: row.dag_version });
          pipeline.hincrby(key, "eventCount", counts.get(id) || 0);
          pipeline.expire(key, LIVE_SESSION_TTL_SECONDS);
        }
        await pipeline.exec();
        live = true;
      }
    } catch (error) { console.error("events: valkey update failed", errorMessage(error)); }
  }
  return NextResponse.json({ ok: true, persisted: Boolean(ch), live, count: rows.length, dropped, ...(forgeEvents.length ? { forge: { count: forgeEvents.length, verified: Boolean(cookieOperator), completed: forge.completed, criticQueued: forge.queued } } : {}) });
}
