import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return NextResponse.json({ events: [], persisted: false });
  const supabase = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data, error } = await supabase.from("spatial_events").select("*").eq("session_id", id).order("sequence", { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 502 });
  return NextResponse.json({ events: data ?? [], persisted: true });
}
