import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export async function POST(request: Request) {
  const body = await request.json().catch(() => null) as { events?: unknown[] } | Record<string, unknown> | null;
  const events = Array.isArray((body as { events?: unknown[] } | null)?.events) ? (body as { events: unknown[] }).events : [body];
  if (!events.length || events.some((event) => !event || typeof event !== "object" || typeof (event as { type?: unknown }).type !== "string")) return NextResponse.json({ error: "Invalid event" }, { status: 400 });
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (url && key) {
    const supabase = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
    const rows = events.map((event) => { const item = event as Record<string, unknown>; return { event_type: item.type as string, operator_code: item.operator ?? null, scenario_id: item.scenario ?? null, part_id: item.partId ?? null, target_id: item.targetId ?? item.attemptedTarget ?? null, rotation: item.rotation ?? null, slot_id: item.slot ?? item.partId ?? null, session_id: item.sessionId ?? null, sequence: item.sequence ?? null, mode: item.mode ?? null, payload: item }; });
    const { error } = await supabase.from("spatial_events").insert(rows);
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 502 });
  }
  return NextResponse.json({ ok: true, persisted: Boolean(url && key), count: events.length });
}
