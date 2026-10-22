import { NextResponse } from "next/server";
import { setOperatorCookie, signIn } from "@/lib/auth";

export const dynamic = "force-dynamic";

// POST { name, pin } -> { operator, created }. First use of a name registers it; later sign-ins verify the PIN.
export async function POST(request: Request) {
  if (Number(request.headers.get("content-length") || 0) > 2048) return NextResponse.json({ error: "Request too large" }, { status: 413 });
  const body = await request.json().catch(() => null) as { name?: unknown; pin?: unknown } | null;
  const result = await signIn(body?.name, typeof body?.pin === "number" ? String(body.pin) : body?.pin);
  if (!result.ok) {
    const response = NextResponse.json({ error: result.error, attemptsLeft: result.attemptsLeft, retryAfter: result.retryAfter }, { status: result.status });
    if (result.retryAfter) response.headers.set("Retry-After", String(result.retryAfter));
    return response;
  }
  const response = NextResponse.json({ operator: result.operator, created: result.created });
  setOperatorCookie(response, request, result.operator);
  return response;
}
