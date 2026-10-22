import { NextResponse } from "next/server";
import { findOperatorById, getOperator, isAdminRequest, isOperatorId } from "@/lib/auth";
import { getShortTerm, listProfiles, shortTermScenarios } from "@/lib/forge/memory";
import { errorMessage } from "@/lib/db/tls";

export const dynamic = "force-dynamic";

// GET ?operatorId= -> { operator, profiles: long-term per scenario, shortTerm: live state per scenario }.
// Admins can read anyone; a signed-in operator can read themselves.
export async function GET(request: Request) {
  const operatorId = new URL(request.url).searchParams.get("operatorId") ?? getOperator(request)?.id;
  if (!isOperatorId(operatorId)) return NextResponse.json({ error: "operatorId is required" }, { status: 400 });
  if (!isAdminRequest(request) && getOperator(request)?.id !== operatorId) return NextResponse.json({ error: "Admin access required" }, { status: 401 });
  try {
    const [operator, profiles, live] = await Promise.all([findOperatorById(operatorId), listProfiles(operatorId), shortTermScenarios(operatorId)]);
    const shortTerm = (await Promise.all(live.map((scenarioId) => getShortTerm(operatorId, scenarioId)))).filter(Boolean);
    return NextResponse.json({ operator: operator ? { id: operator.id, name: operator.name, role: operator.role, createdAt: operator.createdAt, lastSeenAt: operator.lastSeenAt } : { id: operatorId, name: operatorId, role: "unverified" }, profiles, shortTerm });
  } catch (error) { console.error("forge operator: failed", errorMessage(error)); return NextResponse.json({ error: "Memory store unavailable" }, { status: 502 }); }
}
