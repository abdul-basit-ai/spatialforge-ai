import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin";
import { invalidateScenarioCache, isScenario } from "@/lib/agent/guidance-store";
import { cleanGuidance, mergeGuidance, nextVersion } from "@/lib/guidance";
import { isUuid, postgres } from "@/lib/db/postgres";
import { errorMessage } from "@/lib/db/tls";

export const dynamic = "force-dynamic";

// Admin review. { action: "approve" } creates the next dag_versions row (1.0 -> 1.1) with the proposal merged into
// the active guidance, makes it the single active version, and invalidates Coach caches. { action: "reject" } closes it.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  const { id } = await params;
  const body = await request.json().catch(() => ({})) as { action?: string; reviewer?: string };
  if (!isUuid(id) || (body.action !== "approve" && body.action !== "reject")) return NextResponse.json({ error: "Invalid proposal or action" }, { status: 400 });
  const reviewer = typeof body.reviewer === "string" && body.reviewer.trim() ? body.reviewer.trim().slice(0, 64) : "admin";
  const db = postgres();
  if (!db) return NextResponse.json({ error: "DATABASE_URL is not set" }, { status: 503 });
  const client = await db.connect().catch((error) => { console.error("proposals: connect failed", errorMessage(error)); return null; });
  if (!client) return NextResponse.json({ error: "Proposal store unavailable" }, { status: 502 });
  try {
    await client.query("begin");
    const { rows } = await client.query("select id, scenario_id, guidance, status from agent_proposals where id = $1 for update", [id]);
    const proposal = rows[0];
    if (!proposal) { await client.query("rollback"); return NextResponse.json({ error: "Proposal not found" }, { status: 404 }); }
    if (proposal.status !== "pending") { await client.query("rollback"); return NextResponse.json({ error: `Proposal is already ${proposal.status}` }, { status: 409 }); }
    if (!isScenario(proposal.scenario_id)) throw new Error("unknown scenario on proposal");
    if (body.action === "reject") {
      await client.query("update agent_proposals set status = 'rejected', reviewed_at = now(), reviewed_by = $2 where id = $1", [id, reviewer]);
      await client.query("commit");
      return NextResponse.json({ ok: true, status: "rejected", id });
    }
    const scenario = proposal.scenario_id;
    // Lock the scenario's versions so two approvals cannot both compute the same next version.
    const versions = await client.query("select version, guidance, is_active from dag_versions where scenario_id = $1 for update", [scenario]);
    const current = versions.rows.find((row) => row.is_active);
    const base = cleanGuidance(scenario, current?.guidance);
    const guidance = mergeGuidance(base, cleanGuidance(scenario, proposal.guidance));
    const version = nextVersion(versions.rows.map((row) => String(row.version)));
    await client.query("update dag_versions set is_active = false where scenario_id = $1 and is_active", [scenario]);
    await client.query("insert into dag_versions (scenario_id, version, status, guidance, proposal, is_active, reviewed_by, reviewed_at) values ($1,$2,'approved',$3,$4,true,$5,now())", [scenario, version, guidance, { proposalId: id, previousVersion: current?.version ?? null }, reviewer]);
    await client.query("update agent_proposals set status = 'approved', reviewed_at = now(), reviewed_by = $2, approved_version = $3 where id = $1", [id, reviewer, version]);
    await client.query("commit");
    const invalidated = await invalidateScenarioCache(scenario);
    return NextResponse.json({ ok: true, status: "approved", id, scenario, version, previousVersion: current?.version ?? null, guidance, cacheKeysInvalidated: invalidated });
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    console.error("proposals: review failed", errorMessage(error));
    return NextResponse.json({ error: "Proposal review failed" }, { status: 502 });
  } finally { client.release(); }
}
