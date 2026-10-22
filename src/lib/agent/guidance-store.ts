import type { Pool } from "pg";
import type { ScenarioId } from "@/lib/assembly";
import { cleanGuidance, emptyGuidance, type Guidance } from "@/lib/guidance";
import { postgres } from "@/lib/db/postgres";
import { VALKEY_KEYS, valkey, withTimeout } from "@/lib/db/valkey";
import { errorMessage } from "@/lib/db/tls";
import { DEFAULT_DAG_VERSION } from "@/lib/spatial-engine";

export type ActiveGuidance = { scenario: ScenarioId; version: string; guidance: Guidance; persisted: boolean };
const CACHE_SECONDS = 300;

// Active instruction version for a scenario: Valkey cache -> PostgreSQL -> built-in default (1.0, no overrides).
export async function activeGuidance(scenario: ScenarioId, db: Pool | null = postgres()): Promise<ActiveGuidance> {
  const fallback = { scenario, version: DEFAULT_DAG_VERSION, guidance: emptyGuidance(), persisted: false };
  if (!db) return fallback;
  const cache = valkey();
  if (cache) {
    try { const hit = await withTimeout(cache.get(VALKEY_KEYS.activeGuidance(scenario))); if (hit) return { ...JSON.parse(hit) as ActiveGuidance, persisted: true }; }
    catch (error) { console.error("guidance: cache read failed", errorMessage(error)); }
  }
  try {
    const { rows } = await db.query("select version, guidance from dag_versions where scenario_id = $1 and is_active limit 1", [scenario]);
    if (!rows[0]) return fallback;
    const active = { scenario, version: String(rows[0].version), guidance: cleanGuidance(scenario, rows[0].guidance), persisted: true };
    if (cache) await withTimeout(cache.set(VALKEY_KEYS.activeGuidance(scenario), JSON.stringify(active), "EX", CACHE_SECONDS)).catch(() => undefined);
    return active;
  } catch (error) { console.error("guidance: read failed", errorMessage(error)); return fallback; }
}

// Called after a new version goes live: drop the cached active guidance and every Coach briefing for the scenario.
export async function invalidateScenarioCache(scenario: ScenarioId): Promise<number> {
  const cache = valkey();
  if (!cache) return 0;
  let removed = 0;
  try {
    removed += await withTimeout(cache.del(VALKEY_KEYS.activeGuidance(scenario)));
    let cursor = "0";
    do {
      const [next, keys] = await withTimeout(cache.scan(cursor, "MATCH", VALKEY_KEYS.coachPattern(scenario), "COUNT", 200));
      cursor = next;
      if (keys.length) removed += await withTimeout(cache.del(...keys));
    } while (cursor !== "0");
  } catch (error) { console.error("guidance: cache invalidation failed", errorMessage(error)); }
  return removed;
}

export const SCENARIO_SET = new Set<ScenarioId>(["tray", "valve", "pneumatic"]);
export const isScenario = (value: unknown): value is ScenarioId => typeof value === "string" && SCENARIO_SET.has(value as ScenarioId);
export const isOperator = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,32}$/.test(value);
