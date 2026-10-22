import { NextResponse } from "next/server";
import { adminDenied, findOperatorByName, isOperatorId, normalizeName, setOperatorRole } from "@/lib/auth";
import { errorMessage } from "@/lib/db/tls";

export const dynamic = "force-dynamic";

// Admin only (ADMIN_TOKEN bearer or an admin operator). POST { operatorId | name, role: "admin" | "trainee" }.
// The target's cookie keeps its old role until they sign in again.
export async function POST(request: Request) {
  const denied = adminDenied(request);
  if (denied) return denied;
  const body = await request.json().catch(() => null) as { operatorId?: unknown; name?: unknown; role?: unknown } | null;
  if (body?.role !== "admin" && body?.role !== "trainee") return NextResponse.json({ error: "role must be admin or trainee" }, { status: 400 });
  const role = body.role;
  try {
    const id = isOperatorId(body.operatorId) ? body.operatorId : (await findOperatorByName(normalizeName(body.name)))?.id;
    const updated = id ? await setOperatorRole(id, role) : null;
    if (!updated) return NextResponse.json({ error: "Operator not found" }, { status: 404 });
    return NextResponse.json({ operator: { id: updated.id, name: updated.name, role: updated.role } });
  } catch (error) { console.error("auth: role update failed", errorMessage(error)); return NextResponse.json({ error: "Operator store unavailable" }, { status: 502 }); }
}
