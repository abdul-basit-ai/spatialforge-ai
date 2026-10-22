import { NextResponse } from "next/server";
import { clearOperatorCookie } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const response = NextResponse.json({ ok: true });
  clearOperatorCookie(response, request);
  return response;
}
