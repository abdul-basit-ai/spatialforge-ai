import { z } from "zod";
import { clickhouse } from "@/lib/db/clickhouse";
import { isUuid, postgres } from "@/lib/db/postgres";
import { valkey, withTimeout } from "@/lib/db/valkey";
import { errorMessage } from "@/lib/db/tls";
import { getScenario } from "./repo";
import { builtinScenario } from "./samples";
import type { ForgeEvent, ForgeEventType, ForgeScenario, MistakeReason } from "./types";

// Forge memory, server-side only.
//   Short-term (Valkey, 24 h, per operator + scenario): current step, time on it, hesitation, mistakes this session, last 20 events.
//   Long-term (PostgreSQL operator_profiles, scenario_id "forge:<id>"): mistakes by step and reason, average time per step,
//   runs completed, last seen. Rebuilt from ClickHouse when a session completes.
// Every store has an in-process fallback so the app works with no env vars set.

export const FORGE_EVENT_TYPES = ["forge_session_started", "forge_step_started", "forge_step_completed", "forge_mistake", "forge_hint_shown", "forge_vision_check", "forge_session_completed"] as const satisfies readonly ForgeEventType[];
export const MISTAKE_REASONS = ["wrong-part", "out-of-order", "position", "orientation", "blocked", "wrong-tool", "out-of-range", "not-confirmed"] as const satisfies readonly MistakeReason[];
export const HESITATION_MS = 45000;
const STM_TTL_SECONDS = 60 * 60 * 24;
const RECENT_EVENTS = 20;

export const forgeKey = (scenarioId: string) => `forge:${scenarioId}`;
export const isScenarioSlug = (value: unknown): value is string => typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,79}$/.test(value);
const id64 = z.string().max(64).regex(/^[A-Za-z0-9_.:-]*$/);

// Client events are validated here before anything is stored; unknown keys are stripped.
export const forgeEventSchema = z.object({
  type: z.enum(FORGE_EVENT_TYPES),
  scenarioId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/),
  scenarioVersion: z.number().int().min(0).max(1_000_000),
  sessionId: z.string().refine(isUuid, "sessionId must be a UUID"),
  sequence: z.number().int().min(0).max(1_000_000_000),
  operatorId: z.string().max(64).optional(),
  mode: z.enum(["3d", "ar-train", "ar-assist"]),
  stepId: id64.optional(),
  partId: id64.optional(),
  reason: z.enum(MISTAKE_REASONS).optional(),
  message: z.string().max(240).optional(),
  ms: z.number().min(0).max(24 * 3600 * 1000).optional(),
  at: z.string().max(40).optional(),
  ok: z.boolean().optional(), // forge_vision_check result
  confidence: z.number().min(0).max(1).optional(),
});
export type StoredForgeEvent = Omit<ForgeEvent, "operatorId"> & { operatorId: string; operatorVerified: boolean; ok?: boolean; confidence?: number };

export function parseForgeEvent(raw: unknown, cookieOperatorId: string | null): StoredForgeEvent | null {
  const parsed = forgeEventSchema.safeParse(raw);
  if (!parsed.success) return null;
  const event = parsed.data;
  const bodyOperator = event.operatorId && /^[A-Za-z0-9_-]{1,64}$/.test(event.operatorId) ? event.operatorId : "";
  const at = event.at && !Number.isNaN(Date.parse(event.at)) ? new Date(event.at).toISOString() : new Date().toISOString();
  return { ...event, at, operatorId: cookieOperatorId ?? bodyOperator, operatorVerified: Boolean(cookieOperatorId) };
}

// ---------- in-process fallbacks ----------
type Expiring = { value: string; expiresAt: number };
const g = globalThis as typeof globalThis & { __sfForgeEvents?: StoredForgeEvent[]; __sfForgeKv?: Map<string, Expiring>; __sfForgeProfiles?: Map<string, ForgeProfile> };
const memEvents = () => (g.__sfForgeEvents ??= []);
const memKv = () => (g.__sfForgeKv ??= new Map());
const memProfiles = () => (g.__sfForgeProfiles ??= new Map());

// Without ClickHouse, events are kept in process (capped) so analytics, Coach and Critic still have data locally.
export function rememberEvents(events: StoredForgeEvent[]) {
  const list = memEvents();
  list.push(...events);
  if (list.length > 20000) list.splice(0, list.length - 20000);
}
export const memoryEvents = (scenarioId: string) => memEvents().filter((event) => event.scenarioId === scenarioId);

export async function kvGet(key: string): Promise<string | null> {
  const cache = valkey();
  if (cache) { try { return await withTimeout(cache.get(key)); } catch (error) { console.error("memory: valkey read failed", errorMessage(error)); } }
  const hit = memKv().get(key);
  return hit && hit.expiresAt > Date.now() ? hit.value : null;
}
export async function kvSet(key: string, value: string, ttlSeconds: number) {
  memKv().set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  const cache = valkey();
  if (cache) await withTimeout(cache.set(key, value, "EX", ttlSeconds)).catch((error) => console.error("memory: valkey write failed", errorMessage(error)));
}
export async function kvDelPattern(prefix: string): Promise<number> {
  let removed = 0;
  for (const key of [...memKv().keys()]) if (key.startsWith(prefix)) { memKv().delete(key); removed++; }
  const cache = valkey();
  if (!cache) return removed;
  try {
    let cursor = "0";
    do {
      const [next, keys] = await withTimeout(cache.scan(cursor, "MATCH", `${prefix}*`, "COUNT", 200));
      cursor = next;
      if (keys.length) removed += await withTimeout(cache.del(...keys));
    } while (cursor !== "0");
  } catch (error) { console.error("memory: valkey invalidation failed", errorMessage(error)); }
  return removed;
}

// ---------- scenario lookup ----------
// Latest published version, else the latest draft, else a built-in sample.
export async function loadForgeScenario(scenarioId: string, version?: number): Promise<ForgeScenario | null> {
  if (!isScenarioSlug(scenarioId)) return null;
  try {
    if (version) { const exact = await getScenario(scenarioId, { version }); if (exact) return exact; }
    return (await getScenario(scenarioId, { publishedOnly: true })) ?? (await getScenario(scenarioId)) ?? builtinScenario(scenarioId);
  } catch (error) { console.error("memory: scenario load failed", errorMessage(error)); return builtinScenario(scenarioId); }
}

// ---------- short-term memory ----------
export type ShortTermEvent = { type: ForgeEventType; stepId?: string; partId?: string; reason?: MistakeReason; ms?: number; at: string };
export type ShortTermMemory = {
  operatorId: string; scenarioId: string; version: number; sessionId: string; mode: string;
  currentStepId: string | null; stepStartedAt: string | null; timeOnStepMs: number; hesitating: boolean;
  mistakes: Record<string, Partial<Record<MistakeReason, number>>>; mistakeCount: number;
  stepsCompleted: string[]; hintsShown: number; completed: boolean;
  lastEvents: ShortTermEvent[]; updatedAt: string;
};
const stmKey = (operatorId: string, scenarioId: string) => `sf:forge:stm:${operatorId}:${scenarioId}`;
const stmIndexKey = (operatorId: string) => `sf:forge:stm-index:${operatorId}`;

const withClock = (memory: ShortTermMemory, now = Date.now()): ShortTermMemory => {
  const started = memory.stepStartedAt ? Date.parse(memory.stepStartedAt) : NaN;
  const timeOnStepMs = memory.currentStepId && !memory.completed && Number.isFinite(started) ? Math.max(0, now - started) : 0;
  return { ...memory, timeOnStepMs, hesitating: timeOnStepMs > HESITATION_MS };
};

export async function getShortTerm(operatorId: string, scenarioId: string): Promise<ShortTermMemory | null> {
  const raw = await kvGet(stmKey(operatorId, scenarioId));
  if (!raw) return null;
  try { return withClock(JSON.parse(raw) as ShortTermMemory); } catch { return null; }
}

// Scenario ids with live short-term memory for this operator (for the admin drill-down).
export async function shortTermScenarios(operatorId: string): Promise<string[]> {
  const cache = valkey();
  if (cache) { try { return await withTimeout(cache.smembers(stmIndexKey(operatorId))); } catch { /* fall through */ } }
  const prefix = `sf:forge:stm:${operatorId}:`;
  return [...memKv().entries()].filter(([key, item]) => key.startsWith(prefix) && item.expiresAt > Date.now()).map(([key]) => key.slice(prefix.length));
}

function applyEvent(memory: ShortTermMemory | null, event: StoredForgeEvent): ShortTermMemory {
  const fresh = !memory || memory.sessionId !== event.sessionId;
  const base: ShortTermMemory = fresh
    ? { operatorId: event.operatorId, scenarioId: event.scenarioId, version: event.scenarioVersion, sessionId: event.sessionId, mode: event.mode, currentStepId: null, stepStartedAt: null, timeOnStepMs: 0, hesitating: false, mistakes: {}, mistakeCount: 0, stepsCompleted: [], hintsShown: 0, completed: false, lastEvents: memory?.lastEvents ?? [], updatedAt: event.at }
    : { ...memory, mistakes: { ...memory.mistakes }, stepsCompleted: [...memory.stepsCompleted] };
  base.version = event.scenarioVersion; base.mode = event.mode; base.updatedAt = event.at;
  if (event.type === "forge_session_started") { base.completed = false; }
  if (event.type === "forge_step_started" && event.stepId) { base.currentStepId = event.stepId; base.stepStartedAt = event.at; }
  if (event.type === "forge_mistake") {
    const step = event.stepId || base.currentStepId || "_";
    const reason = event.reason ?? "not-confirmed";
    base.mistakes[step] = { ...base.mistakes[step], [reason]: (base.mistakes[step]?.[reason] ?? 0) + 1 };
    base.mistakeCount += 1;
    if (!base.currentStepId && event.stepId) { base.currentStepId = event.stepId; base.stepStartedAt = event.at; }
  }
  if (event.type === "forge_hint_shown") base.hintsShown += 1;
  if (event.type === "forge_step_completed" && event.stepId) {
    if (!base.stepsCompleted.includes(event.stepId)) base.stepsCompleted.push(event.stepId);
    if (base.currentStepId === event.stepId) { base.currentStepId = null; base.stepStartedAt = null; }
  }
  if (event.type === "forge_session_completed") { base.completed = true; base.currentStepId = null; base.stepStartedAt = null; }
  base.lastEvents = [...base.lastEvents, { type: event.type, stepId: event.stepId, partId: event.partId, reason: event.reason, ms: event.ms, at: event.at }].slice(-RECENT_EVENTS);
  return base;
}

// Folds a batch into each operator+scenario's short-term state. Events without an operator are not remembered.
export async function updateShortTerm(events: StoredForgeEvent[]): Promise<number> {
  const groups = new Map<string, StoredForgeEvent[]>();
  for (const event of events) if (event.operatorId) {
    const key = stmKey(event.operatorId, event.scenarioId);
    groups.set(key, [...(groups.get(key) ?? []), event]);
  }
  for (const [key, list] of groups) {
    const { operatorId, scenarioId } = list[0];
    let memory = await getShortTerm(operatorId, scenarioId);
    for (const event of [...list].sort((a, b) => a.at.localeCompare(b.at) || a.sequence - b.sequence)) memory = applyEvent(memory, event);
    await kvSet(key, JSON.stringify(withClock(memory!)), STM_TTL_SECONDS);
    const cache = valkey();
    if (cache) await withTimeout(cache.multi().sadd(stmIndexKey(operatorId), scenarioId).expire(stmIndexKey(operatorId), STM_TTL_SECONDS).exec()).catch(() => undefined);
  }
  return groups.size;
}

// ---------- long-term memory ----------
type ReasonCounts = Partial<Record<MistakeReason, number>>;
export type ForgeProfile = {
  kind: "forge"; scenarioId: string; runs: number; lastSeen: string; lastSessionId: string; lastVersion: number; lastMode: string;
  mistakes: Record<string, ReasonCounts>; totalMistakes: number;
  avgStepMs: Record<string, number>; stepSamples: Record<string, number>;
  lastRun: { sessionId: string; mistakes: Record<string, ReasonCounts>; mistakeCount: number; totalMs: number; at: string } | null;
  recentSessions: string[];
};
export const emptyProfile = (scenarioId: string): ForgeProfile => ({ kind: "forge", scenarioId, runs: 0, lastSeen: "", lastSessionId: "", lastVersion: 0, lastMode: "", mistakes: {}, totalMistakes: 0, avgStepMs: {}, stepSamples: {}, lastRun: null, recentSessions: [] });

type SessionEventRow = { event_type: string; step_id: string; reason: string; ms: number; at: string; mode: string; dag_version: string };

async function sessionEvents(scenarioId: string, operatorId: string, sessionId: string, fallback: StoredForgeEvent[]): Promise<SessionEventRow[]> {
  const ch = clickhouse();
  if (ch) {
    try {
      const result = await ch.query({
        query: "SELECT event_type, target_id AS step_id, JSONExtractString(payload, 'reason') AS reason, JSONExtractFloat(payload, 'ms') AS ms, toUnixTimestamp64Milli(at) AS at_ms, mode, dag_version FROM spatial_events WHERE scenario_id = {scenario:String} AND session_id = {session:String} AND operator_code = {operator:String} ORDER BY at, sequence",
        query_params: { scenario: forgeKey(scenarioId), session: sessionId, operator: operatorId }, format: "JSONEachRow",
      });
      const rows = await result.json<SessionEventRow & { at_ms: string | number }>();
      if (rows.length) return rows.map(({ at_ms, ...row }) => ({ ...row, at: new Date(Number(at_ms)).toISOString(), ms: Number(row.ms) || 0 }));
    } catch (error) { console.error("memory: session events query failed", errorMessage(error)); }
  }
  const source = [...memEvents().filter((event) => event.sessionId === sessionId && event.operatorId === operatorId), ...fallback];
  const seen = new Set<string>();
  return source.filter((event) => { const key = `${event.sequence}:${event.type}`; if (seen.has(key)) return false; seen.add(key); return true; })
    .map((event) => ({ event_type: event.type, step_id: event.stepId ?? "", reason: event.reason ?? "", ms: event.ms ?? 0, at: event.at, mode: event.mode, dag_version: String(event.scenarioVersion) }));
}

export function foldSession(profile: ForgeProfile, sessionId: string, rows: SessionEventRow[], at: string): ForgeProfile {
  if (profile.recentSessions.includes(sessionId)) return profile;
  const next: ForgeProfile = { ...profile, mistakes: structuredClone(profile.mistakes), avgStepMs: { ...profile.avgStepMs }, stepSamples: { ...profile.stepSamples } };
  const runMistakes: Record<string, ReasonCounts> = {};
  let mistakeCount = 0, totalMs = 0;
  const started = new Map<string, number>();
  for (const row of rows) {
    if (row.event_type === "forge_step_started" && row.step_id) started.set(row.step_id, Date.parse(row.at));
    if (row.event_type === "forge_mistake") {
      const step = row.step_id || "_", reason = (MISTAKE_REASONS as readonly string[]).includes(row.reason) ? row.reason as MistakeReason : "not-confirmed";
      runMistakes[step] = { ...runMistakes[step], [reason]: (runMistakes[step]?.[reason] ?? 0) + 1 };
      next.mistakes[step] = { ...next.mistakes[step], [reason]: (next.mistakes[step]?.[reason] ?? 0) + 1 };
      mistakeCount++;
    }
    if (row.event_type === "forge_step_completed" && row.step_id) {
      const begin = started.get(row.step_id);
      const ms = row.ms > 0 ? row.ms : begin !== undefined && Number.isFinite(begin) ? Math.max(0, Date.parse(row.at) - begin) : 0;
      if (ms > 0) {
        const n = next.stepSamples[row.step_id] ?? 0;
        next.avgStepMs[row.step_id] = Math.round(((next.avgStepMs[row.step_id] ?? 0) * n + ms) / (n + 1));
        next.stepSamples[row.step_id] = n + 1;
        totalMs += ms;
      }
    }
  }
  const last = rows.at(-1);
  next.runs += 1; next.totalMistakes += mistakeCount; next.lastSeen = at; next.lastSessionId = sessionId;
  next.lastVersion = Number(last?.dag_version) || profile.lastVersion; next.lastMode = last?.mode || profile.lastMode;
  next.lastRun = { sessionId, mistakes: runMistakes, mistakeCount, totalMs, at };
  next.recentSessions = [...profile.recentSessions, sessionId].slice(-50);
  return next;
}

export async function getProfile(operatorId: string, scenarioId: string): Promise<ForgeProfile | null> {
  const db = postgres();
  if (!db) return memProfiles().get(`${operatorId}:${scenarioId}`) ?? null;
  const { rows } = await db.query("select mistakes from operator_profiles where operator_code = $1 and scenario_id = $2", [operatorId, forgeKey(scenarioId)]);
  const data = rows[0]?.mistakes as ForgeProfile | undefined;
  return data?.kind === "forge" ? data : null;
}

export async function listProfiles(operatorId: string): Promise<ForgeProfile[]> {
  const db = postgres();
  if (!db) return [...memProfiles().entries()].filter(([key]) => key.startsWith(`${operatorId}:`)).map(([, value]) => value);
  const { rows } = await db.query("select mistakes from operator_profiles where operator_code = $1 and scenario_id like 'forge:%' order by updated_at desc", [operatorId]);
  return rows.map((row) => row.mistakes as ForgeProfile).filter((item) => item?.kind === "forge");
}

// Called for forge_session_completed: rebuilds the run from that session's events and folds it into the profile.
// Idempotent per session id (a re-sent completion does not count twice).
export async function completeSession(event: StoredForgeEvent, batch: StoredForgeEvent[]): Promise<{ profile: ForgeProfile; counted: boolean }> {
  const rows = await sessionEvents(event.scenarioId, event.operatorId, event.sessionId, batch.filter((item) => item.sessionId === event.sessionId));
  const db = postgres();
  if (!db) {
    const key = `${event.operatorId}:${event.scenarioId}`;
    const before = memProfiles().get(key) ?? emptyProfile(event.scenarioId);
    const after = foldSession(before, event.sessionId, rows, event.at);
    memProfiles().set(key, after);
    return { profile: after, counted: after !== before };
  }
  const client = await db.connect();
  try {
    await client.query("begin");
    await client.query("insert into operator_profiles (operator_code, scenario_id, mistakes) values ($1,$2,$3) on conflict do nothing", [event.operatorId, forgeKey(event.scenarioId), emptyProfile(event.scenarioId)]);
    const { rows: current } = await client.query("select mistakes from operator_profiles where operator_code = $1 and scenario_id = $2 for update", [event.operatorId, forgeKey(event.scenarioId)]);
    const stored = current[0]?.mistakes as ForgeProfile | undefined;
    const before = stored?.kind === "forge" ? { ...emptyProfile(event.scenarioId), ...stored } : emptyProfile(event.scenarioId);
    const after = foldSession(before, event.sessionId, rows, event.at);
    if (after !== before) await client.query("update operator_profiles set mistakes = $3, updated_at = now() where operator_code = $1 and scenario_id = $2", [event.operatorId, forgeKey(event.scenarioId), after]);
    await client.query("commit");
    if (event.operatorVerified) await db.query("update operators set last_seen_at = now() where id = $1", [event.operatorId]).catch(() => undefined);
    return { profile: after, counted: after !== before };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally { client.release(); }
}
