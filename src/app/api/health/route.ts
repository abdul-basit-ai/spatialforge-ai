import { NextResponse } from "next/server";
import { postgres } from "@/lib/db/postgres";
import { clickhouse } from "@/lib/db/clickhouse";
import { valkey } from "@/lib/db/valkey";
import { errorMessage } from "@/lib/db/tls";

export const dynamic = "force-dynamic";

type Check = { status: "ok" | "down" | "unconfigured"; latencyMs?: number; error?: string };
const TIMEOUT_MS = 4000;

async function probe(configured: boolean, run: () => Promise<unknown>): Promise<Check> {
  if (!configured) return { status: "unconfigured" };
  const started = Date.now();
  try {
    await Promise.race([run(), new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), TIMEOUT_MS))]);
    return { status: "ok", latencyMs: Date.now() - started };
  } catch (error) { return { status: "down", latencyMs: Date.now() - started, error: errorMessage(error).slice(0, 160) }; }
}

// Reachability of each data service. Unconfigured services are not failures (local fallback mode);
// a configured service that is down returns 503 so deployment checks catch it.
export async function GET() {
  const pg = postgres(), ch = clickhouse(), cache = valkey();
  const [postgresCheck, clickhouseCheck, valkeyCheck] = await Promise.all([
    probe(Boolean(pg), () => pg!.query("select 1")),
    probe(Boolean(ch), async () => { const result = await ch!.ping(); if (!result.success) throw result.error; }),
    probe(Boolean(cache), () => cache!.ping()),
  ]);
  const services = { postgres: postgresCheck, clickhouse: clickhouseCheck, valkey: valkeyCheck };
  const ok = Object.values(services).every((check) => check.status !== "down");
  return NextResponse.json({ ok, mode: Object.values(services).every((check) => check.status === "unconfigured") ? "local" : "cloud", services, checkedAt: new Date().toISOString() }, { status: ok ? 200 : 503 });
}
