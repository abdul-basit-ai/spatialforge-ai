import { NextResponse } from "next/server";
import { getOperator } from "@/lib/auth";

export const dynamic = "force-dynamic";

// { operator: { id, name, role } } for the signed-in operator, or 401.
export async function GET(request: Request) {
  const operator = getOperator(request);
  if (!operator) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  return NextResponse.json({ operator });
}
