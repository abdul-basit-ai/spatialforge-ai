import { NextResponse } from "next/server";
import { adminDenied } from "@/lib/auth";
import { processCriticQueue, runCritic } from "@/lib/agent/critic";
import { isForgeScenarioKey, runForgeCritic } from "@/lib/agent/critic-forge";
import { isOperator, isScenario } from "@/lib/agent/guidance-store";
import { isScenarioSlug } from "@/lib/forge/memory";
import { isUuid, postgres } from "@/lib/db/postgres";
import { errorMessage } from "@/lib/db/tls";

export const dynamic = "force-dynamic";
export const maxDuration = 180;

// Critic worker (admin: ADMIN_TOKEN or an admin operator). Body:
//   {}                          process the next queued job (or up to `max`, at most 10); legacy and Forge jobs share the queue
//   { sessionId }               analyse that completed legacy session
//   { scenario, operator? }     ad hoc analysis when the queue is empty (admin "Run critic"); scenario may be "forge:<id>"
//   { scenarioId }              ad hoc Forge analysis (same as scenario "forge:<scenarioId>")
export async function POST(request: Request) {
  const denied = adminDenied(request);
  if (denied) return denied;
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  if (body.sessionId !== undefined && body.scenario === undefined && body.scenarioId === undefined) {
    if (!isUuid(body.sessionId)) return NextResponse.json({ error: "Invalid sessionId" }, { status: 400 });
    const db = postgres();
    if (!db) return NextResponse.json({ error: "DATABASE_URL is not set" }, { status: 503 });
    try {
      const { rows } = await db.query("select operator_code, scenario_id from assembly_sessions where id = $1", [body.sessionId]);
      if (!rows[0]) return NextResponse.json({ error: "Session not found" }, { status: 404 });
      const result = await runCritic({ scenario: rows[0].scenario_id, operator: rows[0].operator_code, sessionId: body.sessionId });
      return NextResponse.json({ ok: result.ok, results: [result] }, { status: result.ok ? 200 : 502 });
    } catch (error) { console.error("critic: session lookup failed", errorMessage(error)); return NextResponse.json({ error: "Session store unavailable" }, { status: 502 }); }
  }
  const forgeId = isScenarioSlug(body.scenarioId) ? body.scenarioId : isForgeScenarioKey(body.scenario) ? body.scenario.slice(6) : null;
  // An explicit Forge request runs right away; queued jobs are left for the queue worker.
  if (forgeId) {
    const result = await runForgeCritic({ scenarioId: forgeId, operator: isOperator(body.operator) ? body.operator : "", sessionId: isUuid(body.sessionId) ? body.sessionId : undefined });
    return NextResponse.json({ ok: result.ok, adHoc: true, results: [result] }, { status: result.ok ? 200 : 502 });
  }
  const max = Math.min(Math.max(Number(body.max) || 1, 1), 10);
  let queue: Awaited<ReturnType<typeof processCriticQueue>> = { results: [], queueEmpty: true, queueAvailable: false };
  try { queue = await processCriticQueue(max); }
  catch (error) { console.error("critic: queue unavailable", errorMessage(error)); }
  if (!queue.results.length && isScenario(body.scenario)) {
    const operator = isOperator(body.operator) ? body.operator : "";
    const result = await runCritic({ scenario: body.scenario, operator });
    return NextResponse.json({ ok: result.ok, adHoc: true, queueEmpty: queue.queueEmpty, results: [result] }, { status: result.ok ? 200 : 502 });
  }
  return NextResponse.json({ ok: queue.results.every((result) => result.ok), processed: queue.results.length, queueEmpty: queue.queueEmpty, queueAvailable: queue.queueAvailable, results: queue.results });
}
