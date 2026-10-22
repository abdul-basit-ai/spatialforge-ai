import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin";
import { processCriticQueue, runCritic } from "@/lib/agent/critic";
import { isOperator, isScenario } from "@/lib/agent/guidance-store";
import { isUuid, postgres } from "@/lib/db/postgres";
import { errorMessage } from "@/lib/db/tls";

export const dynamic = "force-dynamic";
export const maxDuration = 180;

// Critic worker. Body:
//   {}                          process the next queued job (or up to `max`, at most 10)
//   { sessionId }               analyse that completed session
//   { scenario, operator? }     ad hoc analysis when the queue is empty (admin "Run critic")
export async function POST(request: Request) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  if (body.sessionId !== undefined) {
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
  const max = Math.min(Math.max(Number(body.max) || 1, 1), 10);
  let queue = { results: [] as Awaited<ReturnType<typeof runCritic>>[], queueEmpty: true, queueAvailable: false };
  try { queue = await processCriticQueue(max); }
  catch (error) { console.error("critic: queue unavailable", errorMessage(error)); }
  if (!queue.results.length && isScenario(body.scenario)) {
    const operator = isOperator(body.operator) ? body.operator : "";
    const result = await runCritic({ scenario: body.scenario, operator });
    return NextResponse.json({ ok: result.ok, adHoc: true, queueEmpty: queue.queueEmpty, results: [result] }, { status: result.ok ? 200 : 502 });
  }
  return NextResponse.json({ ok: queue.results.every((result) => result.ok), processed: queue.results.length, queueEmpty: queue.queueEmpty, queueAvailable: queue.queueAvailable, results: queue.results });
}
