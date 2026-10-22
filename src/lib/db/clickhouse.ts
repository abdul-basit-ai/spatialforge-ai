import { createClient, type ClickHouseClient } from "@clickhouse/client";
import { trustedCa } from "./tls";

const globalRef = globalThis as typeof globalThis & { __sfCh?: ClickHouseClient | null };

// Shared HTTP(S) client, or null when CLICKHOUSE_URL is unset.
export function clickhouse(): ClickHouseClient | null {
  if (globalRef.__sfCh !== undefined) return globalRef.__sfCh;
  const url = process.env.CLICKHOUSE_URL;
  if (!url) return (globalRef.__sfCh = null);
  const ca = url.startsWith("https:") ? trustedCa() : undefined;
  return (globalRef.__sfCh = createClient({
    url,
    username: process.env.CLICKHOUSE_USER || "default",
    password: process.env.CLICKHOUSE_PASSWORD || "",
    database: process.env.CLICKHOUSE_DATABASE || "default",
    request_timeout: Number(process.env.CLICKHOUSE_TIMEOUT_MS) || 30000,
    tls: ca ? { ca_cert: Buffer.from(ca.join("\n")) } : undefined,
  }));
}

export type SpatialEventRow = { session_id: string; sequence: number; event_type: string; scenario_id: string; operator_code: string; dag_version: string; mode: string; source: string; part_id: string; target_id: string; rotation: number | null; payload: string; at: string };

export async function insertSpatialEvents(client: ClickHouseClient, rows: SpatialEventRow[]) {
  await client.insert({ table: "spatial_events", values: rows, format: "JSONEachRow", clickhouse_settings: { date_time_input_format: "best_effort" } });
}
