import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

function db() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return url && key ? createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } }) : null;
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body?.id || typeof body.operator !== "string" || typeof body.scenario !== "string") return NextResponse.json({ error: "Invalid session" }, { status: 400 });
  const client = db();
  if (!client) return NextResponse.json({ ok: true, persisted: false, id: body.id });
  const { error } = await client.from("assembly_sessions").insert({ id: body.id, operator_code: body.operator, scenario_id: body.scenario, mode: body.mode ?? "workbench", capability_report: body.capabilities ?? {} });
  if (error) return NextResponse.json({ error: error.message }, { status: 502 });
  return NextResponse.json({ ok: true, persisted: true, id: body.id });
}

export async function GET() {
  const client = db();
  if (!client) return NextResponse.json({ sessions: [], persisted: false });
  const { data, error } = await client.from("assembly_sessions").select("*").order("started_at", { ascending: false }).limit(100);
  if (error) return NextResponse.json({ error: error.message }, { status: 502 });
  return NextResponse.json({ sessions: data ?? [], persisted: true });
}
