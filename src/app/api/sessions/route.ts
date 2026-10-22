import { NextResponse } from "next/server";
import { isUuid, postgres } from "@/lib/db/postgres";
import { LIVE_SESSION_TTL_SECONDS, VALKEY_KEYS, valkey, type CriticJob } from "@/lib/db/valkey";
import { errorMessage } from "@/lib/db/tls";
import { DEFAULT_DAG_VERSION } from "@/lib/spatial-engine";
import { isOperator } from "@/lib/agent/guidance-store";

export const dynamic = "force-dynamic";

const SCENARIOS = new Set(["tray", "valve", "pneumatic"]);
const MODES = new Set(["workbench", "camera", "xr-ar", "xr-vr"]);
const MAX_BODY_BYTES = 16 * 1024, MAX_JSON_BYTES = 4096;
// Small JSON objects only: capability reports and run summaries are a few hundred bytes.
const smallObject = (value: unknown) => value && typeof value === "object" && !Array.isArray(value) && JSON.stringify(value).length <= MAX_JSON_BYTES ? value as Record<string, unknown> : null;
const tooLarge = (request: Request) => Number(request.headers.get("content-length") || 0) > MAX_BODY_BYTES;
const failure = (scope: string, error: unknown) => { console.error(`sessions: ${scope}`, errorMessage(error)); return NextResponse.json({ error: "Session store unavailable" }, { status: 502 }); };

export async function POST(request: Request) {
  if (tooLarge(request)) return NextResponse.json({ error: "Session too large" }, { status: 413 });
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body?.id || typeof body.operator !== "string" || typeof body.scenario !== "string") return NextResponse.json({ error: "Invalid session" }, { status: 400 });
  const db = postgres();
  if (!db) return NextResponse.json({ ok: true, persisted: false, id: body.id });
  if (!isUuid(body.id) || !SCENARIOS.has(body.scenario) || !isOperator(body.operator)) return NextResponse.json({ error: "Invalid session" }, { status: 400 });
  if (body.capabilities !== undefined && !smallObject(body.capabilities)) return NextResponse.json({ error: "Capability report too large" }, { status: 413 });
  const mode = typeof body.mode === "string" && MODES.has(body.mode) ? body.mode : "workbench";
  const dagVersion = typeof body.dagVersion === "string" && /^\d{1,4}\.\d{1,4}$/.test(body.dagVersion) ? body.dagVersion : DEFAULT_DAG_VERSION;
  try { await db.query("insert into assembly_sessions (id, operator_code, scenario_id, mode, dag_version, capability_report) values ($1,$2,$3,$4,$5,$6) on conflict (id) do nothing", [body.id, body.operator, body.scenario, mode, dagVersion, smallObject(body.capabilities) ?? {}]); }
  catch (error) { return failure("insert failed", error); }
  const cache = valkey();
  if (cache) {
    const key = VALKEY_KEYS.session(body.id);
    await cache.multi().hset(key, { status: "active", operator: body.operator, scenario: body.scenario, mode, dagVersion, startedAt: new Date().toISOString() }).expire(key, LIVE_SESSION_TTL_SECONDS).exec().catch((error) => console.error("sessions: valkey update failed", errorMessage(error)));
  }
  return NextResponse.json({ ok: true, persisted: true, id: body.id });
}

// Marks a session complete and queues a Critic job. Repeated calls do not queue duplicate jobs.
export async function PATCH(request: Request) {
  if (tooLarge(request)) return NextResponse.json({ error: "Session too large" }, { status: 413 });
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body?.id || typeof body.id !== "string") return NextResponse.json({ error: "Invalid session" }, { status: 400 });
  const db = postgres();
  if (!db) return NextResponse.json({ ok: true, persisted: false, queued: false, id: body.id });
  if (!isUuid(body.id)) return NextResponse.json({ error: "Invalid session" }, { status: 400 });
  if (body.summary !== undefined && !smallObject(body.summary)) return NextResponse.json({ error: "Summary too large" }, { status: 413 });
  const summary = smallObject(body.summary) ?? {};
  let session: { operator_code: string; scenario_id: string; dag_version: string; completed_at: Date } | undefined;
  try {
    const result = await db.query("update assembly_sessions set completed_at = now(), summary = summary || $2::jsonb where id = $1 and completed_at is null returning operator_code, scenario_id, dag_version, completed_at", [body.id, summary]);
    session = result.rows[0];
    if (!session) {
      const existing = await db.query("select completed_at from assembly_sessions where id = $1", [body.id]);
      if (!existing.rowCount) return NextResponse.json({ error: "Session not found" }, { status: 404 });
      return NextResponse.json({ ok: true, persisted: true, queued: false, alreadyCompleted: true, id: body.id });
    }
  } catch (error) { return failure("complete failed", error); }
  const cache = valkey();
  let queued = false;
  if (cache) {
    const job: CriticJob = { sessionId: body.id, operator: session.operator_code, scenario: session.scenario_id, dagVersion: session.dag_version, completedAt: new Date(session.completed_at).toISOString(), queuedAt: new Date().toISOString() };
    const key = VALKEY_KEYS.session(body.id);
    try { await cache.multi().lpush(VALKEY_KEYS.criticQueue, JSON.stringify(job)).hset(key, { status: "complete", completedAt: job.completedAt }).expire(key, LIVE_SESSION_TTL_SECONDS).exec(); queued = true; }
    catch (error) { console.error("sessions: critic job enqueue failed", errorMessage(error)); }
  }
  return NextResponse.json({ ok: true, persisted: true, queued, id: body.id });
}

export async function GET(request: Request) {
  const db = postgres();
  if (!db) return NextResponse.json({ sessions: [], persisted: false });
  const params = new URL(request.url).searchParams;
  const operator = params.get("operator");
  const scenario = params.get("scenario");
  const limit = Math.min(Math.max(Number(params.get("limit")) || 100, 1), 500);
  try {
    const { rows } = await db.query("select id, operator_code, scenario_id, mode, dag_version, started_at, completed_at, summary from assembly_sessions where ($1::text is null or operator_code = $1) and ($2::text is null or scenario_id = $2) order by started_at desc limit $3", [operator, scenario, limit]);
    return NextResponse.json({ sessions: rows, persisted: true });
  } catch (error) { return failure("list failed", error); }
}
