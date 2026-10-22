import { NextResponse } from "next/server";
import { getOperator, isAdminRequest, isOperatorId } from "@/lib/auth";
import { forgeCoach, rulesCoach } from "@/lib/agent/coach-forge";
import { isScenarioSlug } from "@/lib/forge/memory";
import { errorMessage } from "@/lib/db/tls";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// GET ?scenarioId=&operatorId=[&fresh=1][&llm=0] -> { briefing, hints: {[stepId]: string}, focusSteps[], source, ... }.
// operatorId defaults to the signed-in operator. A signed-in non-admin can only ask for themselves.
// Always answers: a deterministic briefing when the stores or the LLM are unavailable.
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const scenarioId = params.get("scenarioId") ?? params.get("scenario");
  if (!isScenarioSlug(scenarioId)) return NextResponse.json({ error: "scenarioId (slug) is required" }, { status: 400 });
  const me = getOperator(request);
  const asked = params.get("operatorId");
  if (asked && !isOperatorId(asked)) return NextResponse.json({ error: "Invalid operatorId" }, { status: 400 });
  const operatorId = asked && (!me || asked === me.id || isAdminRequest(request)) ? asked : me?.id ?? "";
  try { return NextResponse.json(await forgeCoach(scenarioId, operatorId, { fresh: params.get("fresh") === "1", noLlm: params.get("llm") === "0" })); }
  catch (error) {
    console.error("forge coach: failed", errorMessage(error));
    return NextResponse.json({ ...rulesCoach({ scenario: null, scenarioId, operatorId, name: me?.name ?? null, profile: null, shortTerm: null, group: [] }), cached: false, basedOn: { runs: 0, personalMistakes: 0, groupStruggles: 0, sessionMistakes: 0 } });
  }
}
