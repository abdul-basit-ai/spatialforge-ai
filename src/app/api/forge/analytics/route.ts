import { NextResponse } from "next/server";
import { forgeAnalytics, forgeScenarioList } from "@/lib/agent/forge-analytics";
import { isScenarioSlug } from "@/lib/forge/memory";
import { errorMessage } from "@/lib/db/tls";

export const dynamic = "force-dynamic";

// GET ?scenarioId=[&version=] -> per step: attempts, mistakes by reason, mistake rate, median time; top struggling steps;
// per-version comparison. Without scenarioId -> { scenarios } with Forge activity (for pickers).
// Group aggregates only (no per-operator data), so this is readable without admin rights.
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const scenarioId = params.get("scenarioId") ?? params.get("scenario");
  try {
    if (!scenarioId) return NextResponse.json({ scenarios: await forgeScenarioList() });
    if (!isScenarioSlug(scenarioId)) return NextResponse.json({ error: "Invalid scenarioId" }, { status: 400 });
    const version = params.get("version");
    return NextResponse.json(await forgeAnalytics(scenarioId, { version: version && /^\d{1,7}$/.test(version) ? version : undefined }));
  } catch (error) { console.error("forge analytics: failed", errorMessage(error)); return NextResponse.json({ error: "Analytics store unavailable" }, { status: 502 }); }
}
