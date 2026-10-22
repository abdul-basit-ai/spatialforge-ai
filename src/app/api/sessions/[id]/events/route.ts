import { NextResponse } from "next/server";
import { clickhouse } from "@/lib/db/clickhouse";
import { errorMessage } from "@/lib/db/tls";

export const dynamic = "force-dynamic";

// Replay a single session's events from ClickHouse, in sequence order.
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!id || id.length > 64) return NextResponse.json({ error: "Invalid session" }, { status: 400 });
  const ch = clickhouse();
  if (!ch) return NextResponse.json({ events: [], persisted: false });
  try {
    const result = await ch.query({ query: "SELECT session_id, sequence, event_type, scenario_id, operator_code, dag_version, mode, source, part_id, target_id, rotation, payload, at FROM spatial_events WHERE session_id = {id:String} ORDER BY sequence, at LIMIT 5000", query_params: { id }, format: "JSONEachRow" });
    const rows = await result.json<Record<string, unknown>>();
    return NextResponse.json({ events: rows.map((row) => { try { return { ...row, payload: JSON.parse(String(row.payload)) }; } catch { return row; } }), persisted: true });
  } catch (error) { console.error("session events: query failed", errorMessage(error)); return NextResponse.json({ error: "Event store unavailable" }, { status: 502 }); }
}
