import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

// Server-checked shared admin token (demo-grade: no users or sessions). Mutating admin and agent routes call this.
// Returns an error response, or null when the request is authorised.
export function requireAdmin(request: Request): NextResponse | null {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) return NextResponse.json({ error: "Admin actions are disabled: ADMIN_TOKEN is not configured" }, { status: 503 });
  const header = request.headers.get("authorization");
  const provided = request.headers.get("x-admin-token") || (header?.startsWith("Bearer ") ? header.slice(7) : "");
  const digest = (value: string) => createHash("sha256").update(value).digest();
  if (!provided || !timingSafeEqual(digest(provided), digest(expected))) return NextResponse.json({ error: "Admin token required" }, { status: 401 });
  return null;
}
