import { NextResponse } from "next/server";
import { coachBriefing } from "@/lib/agent/coach";
import { isOperator, isScenario } from "@/lib/agent/guidance-store";
import { defaultBriefing } from "@/lib/guidance";
import { errorMessage } from "@/lib/db/tls";

export const dynamic = "force-dynamic";

// Session-start briefing: active guidance version + personal hints. Always answers (default text when data is unavailable).
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const scenario = params.get("scenario"), operator = params.get("operator");
  if (!isScenario(scenario) || !isOperator(operator)) return NextResponse.json({ error: "scenario and operator are required" }, { status: 400 });
  try { return NextResponse.json(await coachBriefing(scenario, operator)); }
  catch (error) { console.error("coach: failed", errorMessage(error)); return NextResponse.json({ ...defaultBriefing(scenario), operator }); }
}
