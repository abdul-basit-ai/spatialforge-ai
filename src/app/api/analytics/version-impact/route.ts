import { NextResponse } from "next/server";
import { getScenario } from "@/lib/assembly";
import { isScenario } from "@/lib/agent/guidance-store";
import { runTool } from "@/lib/agent/tools";
import { clickhouse } from "@/lib/db/clickhouse";
import { postgres } from "@/lib/db/postgres";
import { errorMessage } from "@/lib/db/tls";

export const dynamic = "force-dynamic";

// Error rate per step per instruction version (share of completed runs with a correction at that step), from ClickHouse.
// Approved versions without runs yet are listed too, so a new version shows up before anyone has trained on it.
export async function GET(request: Request) {
  const scenario = new URL(request.url).searchParams.get("scenario");
  if (!isScenario(scenario)) return NextResponse.json({ error: "scenario is required" }, { status: 400 });
  const steps = getScenario(scenario).parts.map((part) => ({ id: part.id, short: part.short }));
  const ch = clickhouse();
  if (!ch) return NextResponse.json({ scenario, steps, versions: [], persisted: false });
  try {
    const measured = await runTool(ch, "versionComparison", { scenario, operator: "", dagVersion: "" });
    let approved: Array<{ version: string; is_active: boolean }> = [];
    const db = postgres();
    if (db) approved = (await db.query("select version, is_active from dag_versions where scenario_id = $1 and status = 'approved' order by created_at", [scenario]).catch(() => ({ rows: [] }))).rows;
    const order = approved.map((row) => String(row.version));
    const versions = [...new Set([...order, ...measured.map((item) => item.version)])].map((version) => {
      const stats = measured.find((item) => item.version === version);
      return { version, active: approved.some((row) => String(row.version) === version && row.is_active), runs: stats?.runs ?? 0, steps: steps.map((step) => { const found = stats?.steps.find((item) => item.stepId === step.id); return { stepId: step.id, runsWithError: found?.runsWithError ?? 0, corrections: found?.corrections ?? 0, rate: found?.rate ?? 0 }; }) };
    });
    return NextResponse.json({ scenario, steps, versions, persisted: true });
  } catch (error) { console.error("version impact: query failed", errorMessage(error)); return NextResponse.json({ error: "Event store unavailable" }, { status: 502 }); }
}
