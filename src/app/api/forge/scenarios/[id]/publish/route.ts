import { NextResponse } from "next/server";
import { errorMessage } from "@/lib/db/tls";
import { saveScenario } from "@/lib/forge/repo";
import { validateScenario } from "@/lib/forge/validate";
import { generateScenarioAudio } from "@/lib/forge/voice-server";
import { MAX_BODY_BYTES, parseScenario } from "../../_lib/schema";
import { authorizePublish, failure, publishedVersion, resolveScenario, validId } from "../../_lib/store";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // voice pre-generation can take a while on long scenarios

// POST /api/forge/scenarios/<id>/publish (admin) body: optional { scenario } with the latest edits.
// Refuses while validateScenario reports issues; otherwise bumps the version, voices every step and stores it as published.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!validId(id)) return NextResponse.json({ error: "Invalid scenario id" }, { status: 400 });
  const auth = await authorizePublish(request);
  if (!auth.ok) return auth.response;
  if (Number(request.headers.get("content-length") || 0) > MAX_BODY_BYTES) return NextResponse.json({ error: "Scenario too large" }, { status: 413 });
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  let scenario;
  if (body?.scenario) {
    const parsed = parseScenario(body.scenario);
    if (!parsed.ok) return NextResponse.json(parsed, { status: 400 });
    if (parsed.scenario.id !== id) return NextResponse.json({ error: "Scenario id does not match the URL" }, { status: 400 });
    scenario = parsed.scenario;
  } else {
    const found = await resolveScenario(id).catch(() => null);
    if (!found) return NextResponse.json({ error: "Scenario not found" }, { status: 404 });
    scenario = found.scenario;
  }
  const issues = validateScenario(scenario);
  if (issues.length) return NextResponse.json({ error: "Fix the scenario issues before publishing", issues }, { status: 422 });
  try {
    // Next version after the last published one; a newer draft keeps its number so it is overwritten, not left behind.
    const version = Math.max((await publishedVersion(id)) + 1, scenario.status === "draft" ? scenario.version : 0);
    let published = { ...scenario, version, status: "published" as const, issues: [] };
    let voiced = 0;
    try {
      published = { ...(await generateScenarioAudio(published)), version, status: "published" as const, issues: [] };
      voiced = published.steps.filter((step) => step.audio?.url).length;
    } catch (error) { console.error("scenarios: audio generation failed", errorMessage(error)); }
    const saved = await saveScenario(published, auth.by);
    return NextResponse.json({ scenario: saved, voiced, steps: saved.steps.length });
  } catch (error) { return failure("publish failed", error); }
}
