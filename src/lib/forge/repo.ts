import { postgres } from "@/lib/db/postgres";
import type { ForgeScenario } from "./types";

// Persistence for Forge scenarios and assets (Aiven PostgreSQL). Server-side only.
// Without DATABASE_URL, scenarios live in an in-process map so the app still works locally.
const memory = globalThis as typeof globalThis & { __forgeMem?: Map<string, ForgeScenario[]>; __forgeAssets?: Map<string, { name: string; mime: string; bytes: Buffer; scenarioId: string | null; meta: Record<string, unknown> }> };
const mem = (): Map<string, ForgeScenario[]> => (memory.__forgeMem ??= new Map());
const memAssets = () => (memory.__forgeAssets ??= new Map());

export const slugify = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "scenario";

// Saves a new draft version (or overwrites the latest draft of the same version).
export async function saveScenario(scenario: ForgeScenario, createdBy?: string): Promise<ForgeScenario> {
  const now = new Date().toISOString();
  const row = { ...scenario, updatedAt: now, createdAt: scenario.createdAt || now };
  const pg = postgres();
  if (!pg) {
    const list = mem().get(row.id) ?? [];
    mem().set(row.id, [...list.filter((item) => item.version !== row.version), row].sort((a, b) => a.version - b.version));
    return row;
  }
  await pg.query(
    `insert into forge_scenarios (id, version, status, title, data, created_by, published_at) values ($1,$2,$3,$4,$5,$6, case when $3 = 'published' then now() end)
     on conflict (id, version) do update set status = excluded.status, title = excluded.title, data = excluded.data, published_at = coalesce(forge_scenarios.published_at, excluded.published_at)`,
    [row.id, row.version, row.status, row.title, JSON.stringify(row), createdBy ?? null],
  );
  return row;
}

// Latest version (any status), or the latest published one when publishedOnly is set.
export async function getScenario(id: string, options: { version?: number; publishedOnly?: boolean } = {}): Promise<ForgeScenario | null> {
  const pg = postgres();
  if (!pg) {
    const list = (mem().get(id) ?? []).filter((item) => (options.publishedOnly ? item.status === "published" : true) && (options.version ? item.version === options.version : true));
    return list.at(-1) ?? null;
  }
  const { rows } = await pg.query(
    `select data from forge_scenarios where id = $1 and ($2::int is null or version = $2) and (not $3 or status = 'published') order by version desc limit 1`,
    [id, options.version ?? null, Boolean(options.publishedOnly)],
  );
  return (rows[0]?.data as ForgeScenario | undefined) ?? null;
}

export type ScenarioSummary = { id: string; version: number; status: ForgeScenario["status"]; title: string; summary: string; domain: ForgeScenario["domain"]; parts: number; steps: number; source: ForgeScenario["source"]["kind"]; updatedAt: string };

// Latest version of every scenario.
export async function listScenarios(options: { publishedOnly?: boolean } = {}): Promise<ScenarioSummary[]> {
  const summarize = (s: ForgeScenario): ScenarioSummary => ({ id: s.id, version: s.version, status: s.status, title: s.title, summary: s.summary, domain: s.domain, parts: s.parts.length, steps: s.steps.length, source: s.source.kind, updatedAt: s.updatedAt });
  const pg = postgres();
  if (!pg) return [...mem().values()].map((list) => [...list].reverse().find((item) => !options.publishedOnly || item.status === "published")).filter((s): s is ForgeScenario => Boolean(s)).map(summarize);
  const { rows } = await pg.query(
    `select distinct on (id) data from forge_scenarios where (not $1 or status = 'published') order by id, version desc`,
    [Boolean(options.publishedOnly)],
  );
  return rows.map((row) => summarize(row.data as ForgeScenario));
}

export async function saveAsset(asset: { name: string; mime: string; bytes: Buffer; scenarioId?: string | null; meta?: Record<string, unknown> }): Promise<string> {
  const pg = postgres();
  if (!pg) { const id = crypto.randomUUID(); memAssets().set(id, { name: asset.name, mime: asset.mime, bytes: asset.bytes, scenarioId: asset.scenarioId ?? null, meta: asset.meta ?? {} }); return id; }
  const { rows } = await pg.query(`insert into forge_assets (scenario_id, name, mime, bytes, meta) values ($1,$2,$3,$4,$5) returning id`, [asset.scenarioId ?? null, asset.name, asset.mime, asset.bytes, JSON.stringify(asset.meta ?? {})]);
  return rows[0].id as string;
}

export async function getAsset(id: string): Promise<{ name: string; mime: string; bytes: Buffer } | null> {
  const pg = postgres();
  if (!pg) return memAssets().get(id) ?? null;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const { rows } = await pg.query(`select name, mime, bytes from forge_assets where id = $1`, [id]);
  return rows[0] ? { name: rows[0].name, mime: rows[0].mime, bytes: rows[0].bytes as Buffer } : null;
}

export async function attachAssets(ids: string[], scenarioId: string) {
  const pg = postgres();
  if (!pg) { for (const id of ids) { const asset = memAssets().get(id); if (asset) asset.scenarioId = scenarioId; } return; }
  if (ids.length) await pg.query(`update forge_assets set scenario_id = $2 where id = any($1::uuid[])`, [ids, scenarioId]);
}
