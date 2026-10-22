import { NextResponse } from "next/server";
import { activeGuidance, isScenario } from "@/lib/agent/guidance-store";
import { isForgeScenarioKey, listForgeProposals } from "@/lib/agent/critic-forge";
import { loadForgeScenario } from "@/lib/forge/memory";
import { postgres } from "@/lib/db/postgres";
import { errorMessage } from "@/lib/db/tls";

export const dynamic = "force-dynamic";

// Proposals for admin review, with the currently active guidance so the UI can diff against it.
// scenario=forge:<id> lists Forge proposals with the current published scenario steps as `active`.
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const scenario = params.get("scenario");
  const status = params.get("status");
  if (isForgeScenarioKey(scenario)) {
    try {
      const [proposals, current] = await Promise.all([listForgeProposals(scenario, status), loadForgeScenario(scenario.slice(6))]);
      const active = current ? { version: String(current.version), steps: Object.fromEntries(current.steps.map((step) => [step.id, { title: step.title, instruction: step.instruction, voiceLine: step.voiceLine, hint: step.hints?.[0] ?? "", warning: step.warnings?.[0] ?? "" }])) } : null;
      return NextResponse.json({ proposals, active, persisted: Boolean(postgres()), forge: true });
    } catch (error) { console.error("proposals: forge list failed", errorMessage(error)); return NextResponse.json({ error: "Proposal store unavailable" }, { status: 502 }); }
  }
  if (!isScenario(scenario)) return NextResponse.json({ error: "scenario is required" }, { status: 400 });
  const db = postgres();
  if (!db) return NextResponse.json({ proposals: [], versions: [], active: null, persisted: false });
  try {
    const [proposals, versions, active] = await Promise.all([
      db.query("select id, scenario_id, based_on_version, step_id, kind, source, model, rationale, evidence, guidance, status, created_at, reviewed_at, reviewed_by, approved_version from agent_proposals where scenario_id = $1 and ($2::text is null or status = $2) order by (status = 'pending') desc, created_at desc limit 50", [scenario, status && ["pending", "approved", "rejected"].includes(status) ? status : null]),
      db.query("select version, is_active, status, created_at, reviewed_by from dag_versions where scenario_id = $1 and status = 'approved' order by created_at", [scenario]),
      activeGuidance(scenario, db),
    ]);
    return NextResponse.json({ proposals: proposals.rows, versions: versions.rows, active, persisted: true });
  } catch (error) { console.error("proposals: list failed", errorMessage(error)); return NextResponse.json({ error: "Proposal store unavailable" }, { status: 502 }); }
}
