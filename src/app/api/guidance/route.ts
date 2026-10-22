import { NextResponse } from "next/server";
import { activeGuidance, isOperator, isScenario } from "@/lib/agent/guidance-store";
import { defaultBriefing } from "@/lib/guidance";
import { errorMessage } from "@/lib/db/tls";

export const dynamic = "force-dynamic";

// Fast path for the trainer: the approved instruction version and its guidance, no LLM. The personal Coach briefing
// (/api/agent/coach) may take much longer and only adds to this, so a slow briefing never leaves a run on the wrong version.
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const scenario = params.get("scenario"), operator = params.get("operator");
  if (!isScenario(scenario)) return NextResponse.json({ error: "scenario is required" }, { status: 400 });
  const who = isOperator(operator) ? operator : "";
  try { const active = await activeGuidance(scenario); return NextResponse.json({ ...defaultBriefing(scenario, active.guidance, active.version), operator: who, persisted: active.persisted }); }
  catch (error) { console.error("guidance: failed", errorMessage(error)); return NextResponse.json({ ...defaultBriefing(scenario), operator: who }); }
}
