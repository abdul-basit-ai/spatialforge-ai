import type { ClickHouseClient } from "@clickhouse/client";
import { listOperators } from "@/lib/auth";
import { clickhouse } from "@/lib/db/clickhouse";
import { postgres } from "@/lib/db/postgres";
import { errorMessage } from "@/lib/db/tls";
import { listScenarios } from "@/lib/forge/repo";
import { forgeKey, loadForgeScenario, memoryEvents, MISTAKE_REASONS, type StoredForgeEvent } from "@/lib/forge/memory";
import type { ForgeScenario, MistakeReason } from "@/lib/forge/types";

// Group struggle analytics for Forge scenarios. ClickHouse with parameterized queries (never string-built SQL);
// without ClickHouse the same numbers are computed from the in-process event log.
// A "run" is a session with a forge_session_completed event. A step "attempt" is a session that touched the step.

export type ReasonCounts = Partial<Record<MistakeReason, number>>;
export type StepStat = { stepId: string; title: string; kind: string; order: number; attempts: number; completions: number; mistakes: number; sessionsWithMistake: number; mistakeRate: number; byReason: ReasonCounts; medianMs: number; hints: number; operators: number };
export type VersionStat = { version: string; runs: number; sessions: number; operators: number; steps: Array<{ stepId: string; attempts: number; sessionsWithMistake: number; mistakeRate: number; medianMs: number }> };
export type ForgeAnalytics = { scenarioId: string; title: string; currentVersion: number | null; version: string | null; versions: VersionStat[]; steps: StepStat[]; topStruggling: StepStat[]; totals: { runs: number; sessions: number; operators: number; mistakes: number }; source: "clickhouse" | "memory" };
// Critic input: per step on one version, share of completed runs with a mistake at that step.
export type StepStruggle = { stepId: string; runsWithError: number; corrections: number; operators: number; totalRuns: number; totalOperators: number; rate: number; byReason: ReasonCounts; dominantReason: MistakeReason; medianMs: number };

const n = (value: unknown) => { const v = Number(value); return Number.isFinite(v) ? v : 0; };
const ratio = (part: number, whole: number) => whole ? Math.round((part / whole) * 1000) / 1000 : 0;
const isReason = (value: unknown): value is MistakeReason => (MISTAKE_REASONS as readonly string[]).includes(String(value));
const median = (values: number[]) => { if (!values.length) return 0; const sorted = [...values].sort((a, b) => a - b); const mid = Math.floor(sorted.length / 2); return Math.round(sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2); };
const STEP_TYPES = ["forge_step_started", "forge_step_completed", "forge_mistake", "forge_hint_shown", "forge_vision_check"];

async function query<T>(ch: ClickHouseClient, sql: string, params: Record<string, unknown>): Promise<T[]> {
  const result = await ch.query({ query: sql, query_params: params, format: "JSONEachRow" });
  return result.json<T>();
}

type StepRow = { version: string; stepId: string; attempts: number; sessionsWithMistake: number; mistakes: number; completions: number; hints: number; medianMs: number; operators: number };
type ReasonRow = { version: string; stepId: string; reason: string; mistakes: number };
type VersionRow = { version: string; runs: number; sessions: number; operators: number };

async function rawFromClickhouse(ch: ClickHouseClient, scenarioId: string) {
  const params = { scenario: forgeKey(scenarioId), types: STEP_TYPES };
  const [steps, reasons, versions] = await Promise.all([
    query<Record<string, unknown>>(ch, `SELECT dag_version, target_id AS step_id, uniqExact(session_id) AS attempts, uniqExactIf(session_id, event_type = 'forge_mistake') AS sessions_with_mistake, countIf(event_type = 'forge_mistake') AS mistakes, countIf(event_type = 'forge_step_completed') AS completions, countIf(event_type = 'forge_hint_shown') AS hints, ifNotFinite(quantileExactIf(0.5)(JSONExtractFloat(payload, 'ms'), event_type = 'forge_step_completed' AND JSONExtractFloat(payload, 'ms') > 0), 0) AS median_ms, uniqExact(operator_code) AS operators FROM spatial_events WHERE scenario_id = {scenario:String} AND target_id != '' AND event_type IN {types:Array(String)} GROUP BY dag_version, step_id`, params),
    query<Record<string, unknown>>(ch, "SELECT dag_version, target_id AS step_id, JSONExtractString(payload, 'reason') AS reason, count() AS mistakes FROM spatial_events WHERE scenario_id = {scenario:String} AND event_type = 'forge_mistake' GROUP BY dag_version, step_id, reason", params),
    query<Record<string, unknown>>(ch, "SELECT dag_version, uniqExactIf(session_id, event_type = 'forge_session_completed') AS runs, uniqExact(session_id) AS sessions, uniqExactIf(operator_code, event_type = 'forge_session_completed') AS operators FROM spatial_events WHERE scenario_id = {scenario:String} GROUP BY dag_version", params),
  ]);
  return {
    steps: steps.map((row): StepRow => ({ version: String(row.dag_version), stepId: String(row.step_id), attempts: n(row.attempts), sessionsWithMistake: n(row.sessions_with_mistake), mistakes: n(row.mistakes), completions: n(row.completions), hints: n(row.hints), medianMs: Math.round(n(row.median_ms)), operators: n(row.operators) })),
    reasons: reasons.map((row): ReasonRow => ({ version: String(row.dag_version), stepId: String(row.step_id), reason: String(row.reason), mistakes: n(row.mistakes) })),
    versions: versions.map((row): VersionRow => ({ version: String(row.dag_version), runs: n(row.runs), sessions: n(row.sessions), operators: n(row.operators) })),
  };
}

function rawFromMemory(events: StoredForgeEvent[]) {
  const byStep = new Map<string, { version: string; stepId: string; sessions: Set<string>; mistakeSessions: Set<string>; operators: Set<string>; mistakes: number; completions: number; hints: number; ms: number[] }>();
  const reasons = new Map<string, ReasonRow>();
  const versions = new Map<string, { runs: Set<string>; sessions: Set<string>; operators: Set<string> }>();
  for (const event of events) {
    const version = String(event.scenarioVersion);
    const v = versions.get(version) ?? { runs: new Set(), sessions: new Set(), operators: new Set() };
    v.sessions.add(event.sessionId);
    if (event.type === "forge_session_completed") { v.runs.add(event.sessionId); v.operators.add(event.operatorId); }
    versions.set(version, v);
    if (!event.stepId || !STEP_TYPES.includes(event.type)) continue;
    const key = `${version}|${event.stepId}`;
    const s = byStep.get(key) ?? { version, stepId: event.stepId, sessions: new Set(), mistakeSessions: new Set(), operators: new Set(), mistakes: 0, completions: 0, hints: 0, ms: [] };
    s.sessions.add(event.sessionId); s.operators.add(event.operatorId);
    if (event.type === "forge_mistake") {
      s.mistakes++; s.mistakeSessions.add(event.sessionId);
      const rk = `${key}|${event.reason ?? ""}`;
      const r = reasons.get(rk) ?? { version, stepId: event.stepId, reason: event.reason ?? "", mistakes: 0 };
      r.mistakes++; reasons.set(rk, r);
    }
    if (event.type === "forge_step_completed") { s.completions++; if (event.ms && event.ms > 0) s.ms.push(event.ms); }
    if (event.type === "forge_hint_shown") s.hints++;
    byStep.set(key, s);
  }
  return {
    steps: [...byStep.values()].map((s): StepRow => ({ version: s.version, stepId: s.stepId, attempts: s.sessions.size, sessionsWithMistake: s.mistakeSessions.size, mistakes: s.mistakes, completions: s.completions, hints: s.hints, medianMs: median(s.ms), operators: s.operators.size })),
    reasons: [...reasons.values()],
    versions: [...versions.entries()].map(([version, v]): VersionRow => ({ version, runs: v.runs.size, sessions: v.sessions.size, operators: v.operators.size })),
  };
}

export async function forgeAnalytics(scenarioId: string, options: { version?: string; scenario?: ForgeScenario | null } = {}): Promise<ForgeAnalytics> {
  const scenario = options.scenario !== undefined ? options.scenario : await loadForgeScenario(scenarioId);
  const ch = clickhouse();
  let raw: ReturnType<typeof rawFromMemory>, source: ForgeAnalytics["source"] = "memory";
  if (ch) {
    try { raw = await rawFromClickhouse(ch, scenarioId); source = "clickhouse"; }
    catch (error) { console.error("forge-analytics: clickhouse failed", errorMessage(error)); raw = rawFromMemory(memoryEvents(scenarioId)); }
  } else raw = rawFromMemory(memoryEvents(scenarioId));
  const order = new Map((scenario?.steps ?? []).map((step, index) => [step.id, index]));
  const known = (stepId: string) => !scenario || order.has(stepId);
  const versionList = [...raw.versions].sort((a, b) => Number(a.version) - Number(b.version) || a.version.localeCompare(b.version));
  const withData = versionList.filter((v) => v.sessions > 0);
  const selected = options.version && versionList.some((v) => v.version === options.version) ? options.version
    : scenario && withData.some((v) => v.version === String(scenario.version)) ? String(scenario.version) : withData.at(-1)?.version ?? null;
  const versions: VersionStat[] = versionList.map((v) => ({ ...v, steps: raw.steps.filter((s) => s.version === v.version && known(s.stepId)).map((s) => ({ stepId: s.stepId, attempts: s.attempts, sessionsWithMistake: s.sessionsWithMistake, mistakeRate: ratio(s.sessionsWithMistake, s.attempts), medianMs: s.medianMs })) }));
  const rows = raw.steps.filter((s) => s.version === selected && known(s.stepId));
  const stepIds = scenario ? scenario.steps.map((step) => step.id) : rows.map((row) => row.stepId);
  const steps: StepStat[] = stepIds.map((stepId, index) => {
    const row = rows.find((item) => item.stepId === stepId);
    const def = scenario?.steps.find((step) => step.id === stepId);
    const byReason: ReasonCounts = {};
    for (const r of raw.reasons) if (r.version === selected && r.stepId === stepId && isReason(r.reason)) byReason[r.reason] = (byReason[r.reason] ?? 0) + r.mistakes;
    return { stepId, title: def?.title ?? stepId, kind: def?.kind ?? "", order: order.get(stepId) ?? index, attempts: row?.attempts ?? 0, completions: row?.completions ?? 0, mistakes: row?.mistakes ?? 0, sessionsWithMistake: row?.sessionsWithMistake ?? 0, mistakeRate: ratio(row?.sessionsWithMistake ?? 0, row?.attempts ?? 0), byReason, medianMs: row?.medianMs ?? 0, hints: row?.hints ?? 0, operators: row?.operators ?? 0 };
  });
  const topStruggling = [...steps].filter((step) => step.mistakeRate > 0).sort((a, b) => b.mistakeRate - a.mistakeRate || b.mistakes - a.mistakes || b.medianMs - a.medianMs).slice(0, 3);
  const current = versionList.find((v) => v.version === selected);
  return { scenarioId, title: scenario?.title ?? scenarioId, currentVersion: scenario?.version ?? null, version: selected, versions, steps, topStruggling, totals: { runs: current?.runs ?? 0, sessions: current?.sessions ?? 0, operators: current?.operators ?? 0, mistakes: steps.reduce((sum, step) => sum + step.mistakes, 0) }, source };
}

// Per step on one version: completed runs with at least one mistake there (any reason), plus the reason breakdown.
export async function stepStruggles(scenarioId: string, version: string): Promise<StepStruggle[]> {
  const ch = clickhouse();
  type Row = { stepId: string; reason: string; sessions: string[]; operators: string[]; corrections: number };
  let rows: Row[] = [], totalRuns = 0, totalOperators = 0, medians = new Map<string, number>();
  if (ch) {
    const params = { scenario: forgeKey(scenarioId), version };
    const completed = "session_id IN (SELECT session_id FROM spatial_events WHERE scenario_id = {scenario:String} AND dag_version = {version:String} AND event_type = 'forge_session_completed')";
    const [totals, list, times] = await Promise.all([
      query<Record<string, unknown>>(ch, "SELECT uniqExact(session_id) AS runs, uniqExact(operator_code) AS operators FROM spatial_events WHERE scenario_id = {scenario:String} AND dag_version = {version:String} AND event_type = 'forge_session_completed'", params),
      query<Record<string, unknown>>(ch, `SELECT target_id AS step_id, JSONExtractString(payload, 'reason') AS reason, groupUniqArray(10000)(session_id) AS sessions, groupUniqArray(1000)(operator_code) AS operators, count() AS corrections FROM spatial_events WHERE scenario_id = {scenario:String} AND dag_version = {version:String} AND event_type = 'forge_mistake' AND target_id != '' AND ${completed} GROUP BY step_id, reason`, params),
      query<Record<string, unknown>>(ch, "SELECT target_id AS step_id, ifNotFinite(quantileExact(0.5)(JSONExtractFloat(payload, 'ms')), 0) AS median_ms FROM spatial_events WHERE scenario_id = {scenario:String} AND dag_version = {version:String} AND event_type = 'forge_step_completed' AND JSONExtractFloat(payload, 'ms') > 0 GROUP BY step_id", params),
    ]);
    totalRuns = n(totals[0]?.runs); totalOperators = n(totals[0]?.operators);
    rows = list.map((row) => ({ stepId: String(row.step_id), reason: String(row.reason), sessions: (row.sessions as string[]) ?? [], operators: (row.operators as string[]) ?? [], corrections: n(row.corrections) }));
    medians = new Map(times.map((row) => [String(row.step_id), Math.round(n(row.median_ms))]));
  } else {
    const events = memoryEvents(scenarioId).filter((event) => String(event.scenarioVersion) === version);
    const done = new Set(events.filter((event) => event.type === "forge_session_completed").map((event) => event.sessionId));
    totalRuns = done.size; totalOperators = new Set(events.filter((event) => event.type === "forge_session_completed").map((event) => event.operatorId)).size;
    const map = new Map<string, Row>();
    for (const event of events) if (event.type === "forge_mistake" && event.stepId && done.has(event.sessionId)) {
      const key = `${event.stepId}|${event.reason ?? ""}`;
      const row = map.get(key) ?? { stepId: event.stepId, reason: event.reason ?? "", sessions: [], operators: [], corrections: 0 };
      if (!row.sessions.includes(event.sessionId)) row.sessions.push(event.sessionId);
      if (!row.operators.includes(event.operatorId)) row.operators.push(event.operatorId);
      row.corrections++; map.set(key, row);
    }
    rows = [...map.values()];
    const times = new Map<string, number[]>();
    for (const event of events) if (event.type === "forge_step_completed" && event.stepId && event.ms) times.set(event.stepId, [...(times.get(event.stepId) ?? []), event.ms]);
    medians = new Map([...times].map(([id, list]) => [id, median(list)]));
  }
  const steps = new Map<string, { sessions: Set<string>; operators: Set<string>; corrections: number; byReason: ReasonCounts }>();
  for (const row of rows) {
    const step = steps.get(row.stepId) ?? { sessions: new Set(), operators: new Set(), corrections: 0, byReason: {} };
    row.sessions.forEach((id) => step.sessions.add(id)); row.operators.forEach((id) => step.operators.add(id));
    step.corrections += row.corrections;
    if (isReason(row.reason)) step.byReason[row.reason] = (step.byReason[row.reason] ?? 0) + row.sessions.length;
    steps.set(row.stepId, step);
  }
  return [...steps.entries()].map(([stepId, step]) => {
    const dominant = (Object.entries(step.byReason) as Array<[MistakeReason, number]>).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "not-confirmed";
    return { stepId, runsWithError: step.sessions.size, corrections: step.corrections, operators: step.operators.size, totalRuns, totalOperators, rate: ratio(step.sessions.size, totalRuns), byReason: step.byReason, dominantReason: dominant, medianMs: medians.get(stepId) ?? 0 };
  }).sort((a, b) => b.rate - a.rate || b.corrections - a.corrections);
}

// Scenarios that have Forge events or are stored in the repo, for the admin picker.
export async function forgeScenarioList(): Promise<Array<{ id: string; title: string; version: number | null; status: string | null; runs: number; operators: number; lastEventAt: string | null }>> {
  const stored = await listScenarios().catch(() => []);
  const ch = clickhouse();
  let activity: Array<{ id: string; runs: number; operators: number; last: string | null }> = [];
  if (ch) {
    try {
      activity = (await query<Record<string, unknown>>(ch, "SELECT substring(scenario_id, 7) AS id, uniqExactIf(session_id, event_type = 'forge_session_completed') AS runs, uniqExact(operator_code) AS operators, toUnixTimestamp64Milli(max(at)) AS last_ms FROM spatial_events WHERE startsWith(scenario_id, 'forge:') GROUP BY scenario_id ORDER BY last_ms DESC LIMIT 200", {}))
        .map((row) => ({ id: String(row.id), runs: n(row.runs), operators: n(row.operators), last: row.last_ms ? new Date(n(row.last_ms)).toISOString() : null }));
    } catch (error) { console.error("forge-analytics: scenario list failed", errorMessage(error)); }
  } else {
    const ids = new Set<string>();
    const g = globalThis as typeof globalThis & { __sfForgeEvents?: StoredForgeEvent[] };
    for (const event of g.__sfForgeEvents ?? []) ids.add(event.scenarioId);
    activity = [...ids].map((id) => { const events = memoryEvents(id); return { id, runs: new Set(events.filter((e) => e.type === "forge_session_completed").map((e) => e.sessionId)).size, operators: new Set(events.map((e) => e.operatorId)).size, last: events.at(-1)?.at ?? null }; });
  }
  const ids = [...new Set([...activity.map((item) => item.id), ...stored.map((item) => item.id)])];
  return ids.map((id) => {
    const s = stored.find((item) => item.id === id), a = activity.find((item) => item.id === id);
    return { id, title: s?.title ?? id, version: s?.version ?? null, status: s?.status ?? null, runs: a?.runs ?? 0, operators: a?.operators ?? 0, lastEventAt: a?.last ?? null };
  }).sort((a, b) => (b.lastEventAt ?? "").localeCompare(a.lastEventAt ?? "") || b.runs - a.runs);
}

// Operators with Forge activity: registered operators joined with their long-term profiles.
export type PersonRow = { id: string; name: string; role: string; registered: boolean; createdAt: string | null; lastSeenAt: string | null; runs: number; scenarios: number; mistakes: number };
export async function forgePeople(): Promise<PersonRow[]> {
  const db = postgres();
  const operators = await listOperators();
  const stats = new Map<string, { runs: number; scenarios: number; mistakes: number; last: string | null }>();
  if (db) {
    const { rows } = await db.query("select operator_code, count(*)::int as scenarios, coalesce(sum((mistakes->>'runs')::int), 0)::int as runs, coalesce(sum((mistakes->>'totalMistakes')::int), 0)::int as mistakes, max(updated_at) as last from operator_profiles where scenario_id like 'forge:%' and mistakes->>'kind' = 'forge' group by operator_code");
    for (const row of rows) stats.set(row.operator_code, { runs: row.runs, scenarios: row.scenarios, mistakes: row.mistakes, last: row.last ? new Date(row.last).toISOString() : null });
  } else {
    const g = globalThis as typeof globalThis & { __sfForgeProfiles?: Map<string, { runs: number; totalMistakes: number; lastSeen: string }> };
    for (const [key, profile] of g.__sfForgeProfiles ?? []) {
      const id = key.split(":")[0], prev = stats.get(id) ?? { runs: 0, scenarios: 0, mistakes: 0, last: null };
      stats.set(id, { runs: prev.runs + profile.runs, scenarios: prev.scenarios + 1, mistakes: prev.mistakes + profile.totalMistakes, last: [prev.last, profile.lastSeen].filter(Boolean).sort().at(-1) ?? null });
    }
  }
  const people: PersonRow[] = operators.map((op) => { const s = stats.get(op.id); return { id: op.id, name: op.name, role: op.role, registered: true, createdAt: op.createdAt, lastSeenAt: [op.lastSeenAt, s?.last].filter(Boolean).sort().at(-1) ?? null, runs: s?.runs ?? 0, scenarios: s?.scenarios ?? 0, mistakes: s?.mistakes ?? 0 }; });
  for (const [id, s] of stats) if (!operators.some((op) => op.id === id)) people.push({ id, name: id, role: "unverified", registered: false, createdAt: null, lastSeenAt: s.last, runs: s.runs, scenarios: s.scenarios, mistakes: s.mistakes });
  return people.sort((a, b) => (b.lastSeenAt ?? "").localeCompare(a.lastSeenAt ?? ""));
}
