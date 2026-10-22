import { NextResponse } from "next/server";
import { adminDenied } from "@/lib/auth";
import { forgePeople } from "@/lib/agent/forge-analytics";
import { errorMessage } from "@/lib/db/tls";

export const dynamic = "force-dynamic";

// Admin: operators with runs, mistakes and last seen. Operators that only ever sent unverified ids are listed too.
export async function GET(request: Request) {
  const denied = adminDenied(request);
  if (denied) return denied;
  try { return NextResponse.json({ people: await forgePeople() }); }
  catch (error) { console.error("forge people: failed", errorMessage(error)); return NextResponse.json({ error: "Operator store unavailable" }, { status: 502 }); }
}
