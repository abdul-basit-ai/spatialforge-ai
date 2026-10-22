import { NextResponse } from "next/server";
import { clickhouse, insertSpatialEvents, type SpatialEventRow } from "@/lib/db/clickhouse";
import { LIVE_SESSION_TTL_SECONDS, VALKEY_KEYS, valkey } from "@/lib/db/valkey";
import { errorMessage } from "@/lib/db/tls";
import { DEFAULT_DAG_VERSION } from "@/lib/spatial-engine";

const MAX_BATCH = 500;
const text = (value: unknown, max = 120) => typeof value === "string" ? value.slice(0, max) : typeof value === "number" ? String(value) : "";

// Accepts both the client SpatialEvent shape (telemetry queue) and the flat store events.
function toRow(item: Record<string, unknown>): SpatialEventRow {
  const payload = item.payload && typeof item.payload === "object" ? item.payload as Record<string, unknown> : {};
  const rotation = typeof item.rotation === "number" ? item.rotation : typeof payload.rotation === "number" ? payload.rotation : null;
  const at = typeof item.at === "string" && !Number.isNaN(Date.parse(item.at)) ? item.at : new Date().toISOString();
  return {
    session_id: text(item.sessionId, 64), sequence: Number.isInteger(item.sequence) && (item.sequence as number) >= 0 ? item.sequence as number : 0,
    event_type: text(item.type, 64), scenario_id: text(item.scenario, 32), operator_code: text(item.operator ?? payload.operator, 32),
    dag_version: text(item.dagVersion, 32) || DEFAULT_DAG_VERSION, mode: text(item.mode, 16), source: text(item.source, 16),
    part_id: text(item.partId ?? payload.partId ?? payload.attemptedPartId, 16), target_id: text(item.targetId ?? item.attemptedTarget ?? payload.target, 16),
    rotation: rotation === null ? null : Math.round(rotation), payload: JSON.stringify(item).slice(0, 8000), at,
  };
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null) as { events?: unknown[] } | Record<string, unknown> | null;
  const events = Array.isArray((body as { events?: unknown[] } | null)?.events) ? (body as { events: unknown[] }).events : [body];
  if (!events.length || events.length > MAX_BATCH || events.some((event) => !event || typeof event !== "object" || typeof (event as { type?: unknown }).type !== "string")) return NextResponse.json({ error: "Invalid event" }, { status: 400 });
  const rows = events.map((event) => toRow(event as Record<string, unknown>));
  const ch = clickhouse();
  if (ch) {
    try { await insertSpatialEvents(ch, rows); }
    catch (error) { console.error("events: clickhouse insert failed", errorMessage(error)); return NextResponse.json({ ok: false, error: "Event store unavailable" }, { status: 502 }); }
  }
  // Live session state is best effort: a Valkey outage must not drop events that already reached ClickHouse.
  const cache = valkey();
  let live = false;
  if (cache) {
    try {
      const latest = new Map<string, SpatialEventRow>();
      const counts = new Map<string, number>();
      for (const row of rows) if (row.session_id) { latest.set(row.session_id, row); counts.set(row.session_id, (counts.get(row.session_id) || 0) + 1); }
      if (latest.size) {
        const pipeline = cache.multi();
        for (const [id, row] of latest) {
          const key = VALKEY_KEYS.session(id);
          pipeline.hset(key, { lastEventType: row.event_type, lastEventAt: row.at, lastSequence: String(row.sequence), operator: row.operator_code, scenario: row.scenario_id, dagVersion: row.dag_version });
          pipeline.hincrby(key, "eventCount", counts.get(id) || 0);
          pipeline.expire(key, LIVE_SESSION_TTL_SECONDS);
        }
        await pipeline.exec();
        live = true;
      }
    } catch (error) { console.error("events: valkey update failed", errorMessage(error)); }
  }
  return NextResponse.json({ ok: true, persisted: Boolean(ch), live, count: events.length });
}
