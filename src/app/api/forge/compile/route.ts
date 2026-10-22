import { NextResponse } from "next/server";
import { openaiConfigured } from "@/lib/ai/openai";
import { allowLlmCall, valkey } from "@/lib/db/valkey";
import { errorMessage } from "@/lib/db/tls";
import { CompileError, CompileLog, CompileRequestSchema, compileScenario } from "@/lib/forge/compiler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 240;

// Scene compiler. Body: { prompt?, domain?, notes?, scenarioId?, assets: [{id,name,mime,kind}], cad: {assetId, parts:[...]} | null }
// Returns { scenario, issues, log, ms, citations, saved }. The scenario is saved as a draft (publishing is the editor's job).
export async function POST(request: Request) {
  const log = new CompileLog();
  const body = await request.json().catch(() => null);
  const parsed = CompileRequestSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid compile request", details: parsed.error.issues.slice(0, 6).map((i) => `${i.path.join(".")}: ${i.message}`), log: log.lines }, { status: 400 });
  if (openaiConfigured() && !(await allowLlmCall(valkey(), "forge-compile", 6))) return NextResponse.json({ error: "Too many compile requests; try again in a minute.", log: log.lines }, { status: 429 });
  try {
    const result = await compileScenario(parsed.data, log, request.headers.get("x-operator-id") ?? undefined);
    return NextResponse.json(result);
  } catch (error) {
    const status = error instanceof CompileError ? error.status : 500;
    const message = errorMessage(error);
    log.add(`Failed: ${message}`);
    if (status >= 500) console.error("forge-compile failed", message);
    return NextResponse.json({ error: message, log: log.lines }, { status });
  }
}
