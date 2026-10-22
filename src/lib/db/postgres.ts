import { Pool } from "pg";
import { aivenCa } from "./tls";

const globalRef = globalThis as typeof globalThis & { __sfPg?: Pool | null };

// Shared pool, or null when DATABASE_URL is unset (routes then answer persisted:false).
export function postgres(): Pool | null {
  if (globalRef.__sfPg !== undefined) return globalRef.__sfPg;
  const url = process.env.DATABASE_URL;
  if (!url) return (globalRef.__sfPg = null);
  const ca = aivenCa();
  let connectionString = url;
  if (ca) {
    // sslmode in the URL would override the ssl object below, so verification is configured here instead (verify-full).
    const parsed = new URL(url); parsed.searchParams.delete("sslmode"); connectionString = parsed.toString();
  }
  const pool = new Pool({ connectionString, ssl: ca ? { ca, rejectUnauthorized: true } : undefined, max: Number(process.env.PG_POOL_MAX || 5), connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000 });
  pool.on("error", (error) => console.error("postgres pool error", error.message));
  return (globalRef.__sfPg = pool);
}

export const isUuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
