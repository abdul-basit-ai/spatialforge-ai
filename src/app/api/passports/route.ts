import { NextResponse } from "next/server";
import { getScenario, normalizeRotation, type ScenarioId } from "@/lib/assembly";
import { isUuid, postgres } from "@/lib/db/postgres";
import { errorMessage } from "@/lib/db/tls";
import { DEFAULT_DAG_VERSION } from "@/lib/spatial-engine";

export async function POST(request: Request) {
  const passport = await request.json().catch(() => null);
  const scenarioId = passport?.scenario as ScenarioId | undefined;
  const definition = scenarioId === "tray" || scenarioId === "valve" ? getScenario(scenarioId) : null;
  if (!passport?.sha256 || !passport?.evidence || !definition || !Array.isArray(passport.evidence.placements)) return NextResponse.json({ error: "Invalid passport" }, { status: 400 });
  const placements = passport.evidence.placements as Array<{ partId?: string; targetId?: string; rotation?: number }>;
  const expected = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(passport.evidence))))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  if (passport.sha256 !== expected) return NextResponse.json({ error: "Passport hash does not match evidence" }, { status: 400 });
  if (placements.length !== definition.parts.length || new Set(placements.map((placement) => placement.partId)).size !== definition.parts.length) return NextResponse.json({ error: "Every scenario part must be placed exactly once" }, { status: 400 });
  const seen = new Set<string>();
  for (const placement of placements) {
    const part = definition.parts.find((candidate) => candidate.id === placement.partId);
    if (!part || placement.targetId !== part.target || normalizeRotation(placement.rotation || 0) !== normalizeRotation(part.requiredRotation) || seen.has(part.id)) return NextResponse.json({ error: "Placement evidence does not match the scenario manifest" }, { status: 400 });
    if (part.prerequisites.some((requirement) => !seen.has(requirement))) return NextResponse.json({ error: "Prerequisite order is incomplete" }, { status: 400 });
    seen.add(part.id);
  }
  const db = postgres();
  if (db) {
    const sessionId = isUuid(passport.sessionId) ? passport.sessionId : null;
    const dagVersion = typeof passport.dagVersion === "string" ? passport.dagVersion.slice(0, 32) : DEFAULT_DAG_VERSION;
    try { await db.query("insert into completion_passports (operator_code, scenario_id, session_id, dag_version, evidence, sha256) values ($1,$2,$3,$4,$5,$6) on conflict (sha256) do nothing", [String(passport.operator ?? passport.evidence.operator ?? ""), scenarioId, sessionId, dagVersion, passport.evidence, passport.sha256]); }
    catch (error) { console.error("passports: insert failed", errorMessage(error)); return NextResponse.json({ error: "Passport store unavailable" }, { status: 502 }); }
  }
  return NextResponse.json({ ok: true, persisted: Boolean(db), sha256: passport.sha256 });
}
