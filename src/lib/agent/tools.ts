import type { ClickHouseClient } from "@clickhouse/client";
import { randomUUID } from "node:crypto";
import { getScenario, type ScenarioId } from "@/lib/assembly";

// Fixed, parameterized ClickHouse queries: the only way agents read event data. Models choose tools by
// name; they never write SQL. A "run" is a completed session (one with a session_completed event).
export const TOOL_NAMES = ["operatorMistakes", "stepErrorRates", "commonWrongOrder", "hesitationByStep", "versionComparison"] as const;
export type ToolName = typeof TOOL_NAMES[number];
export const TOOL_DESCRIPTIONS: Record<ToolName, string> = {
  operatorMistakes: "This operator's corrections by step and kind across their runs, plus which happened in their latest run.",
  stepErrorRates: "For the current instruction version: share of all operators' runs with a correction at each step, by kind.",
  commonWrongOrder: "For the current instruction version: the most frequent out-of-order part picks (attempted part vs the part that was required).",
  hesitationByStep: "Median milliseconds from first grab to verified placement per step, across all runs.",
  versionComparison: "Error rate per step for every instruction version, to see whether earlier changes helped.",
};
export const CORRECTION_KINDS = ["out_of_sequence_pick", "wrong-target", "orientation", "prerequisite", "tracking-lost"];
export type ToolArgs = { scenario: string; operator: string; dagVersion: string; sessionId?: string };

// The step an out-of-order pick belongs to is the part that was required at that moment, not the part grabbed.
// Live events nest the client payload one level deeper than seeded ones, so both paths are read.
const REQUIRED = "if(JSONExtractString(payload, 'requiredPartId') != '', JSONExtractString(payload, 'requiredPartId'), JSONExtractString(payload, 'payload', 'requiredPartId'))";
const STEP = `if(event_type = 'out_of_sequence_pick' AND ${REQUIRED} != '', ${REQUIRED}, part_id)`;
const COMPLETED = (version: boolean) => `session_id IN (SELECT session_id FROM spatial_events WHERE scenario_id = {scenario:String}${version ? " AND dag_version = {version:String}" : ""} AND event_type = 'session_completed')`;

const n = (value: unknown) => Number(value) || 0;
// Event rows are client-supplied: any id that is not a part of the scenario is dropped, so free text never reaches
// profiles, briefings, or prompts. Empty ids (e.g. no required part) are allowed.
export const knownParts = (scenario: string, ...ids: unknown[]) => ids.every((id) => id === "" || id === undefined || id === null || Boolean(getScenario(scenario as ScenarioId)?.parts.some((part) => part.id === id)));
const rate = (part: number, whole: number) => whole ? Math.round((part / whole) * 1000) / 1000 : 0;

async function rows(ch: ClickHouseClient, tool: ToolName, query: string, params: Record<string, unknown>) {
  const result = await ch.query({ query, query_params: params, format: "JSONEachRow", query_id: `sf-${tool}-${randomUUID()}` });
  return result.json<Record<string, unknown>>();
}

export type StepRate = { stepId: string; kind: string; runsWithError: number; operators: number; corrections: number; totalRuns: number; totalOperators: number; rate: number };
export type WrongOrder = { attemptedPartId: string; requiredPartId: string; attempts: number; runs: number; operators: number; totalRuns: number; rate: number };
export type VersionStats = { version: string; runs: number; steps: Array<{ stepId: string; runsWithError: number; corrections: number; rate: number }> };
export type OperatorMistakes = { operator: string; runs: number; lastSessionId: string; mistakes: Array<{ stepId: string; partId: string; kind: string; requiredPartId: string; corrections: number; runs: number; inLastRun: number }> };
export type ToolResults = Partial<{ operatorMistakes: OperatorMistakes; stepErrorRates: StepRate[]; commonWrongOrder: WrongOrder[]; hesitationByStep: Array<{ stepId: string; medianMs: number; samples: number }>; versionComparison: VersionStats[] }>;

async function totals(ch: ClickHouseClient, tool: ToolName, args: ToolArgs) {
  const [row] = await rows(ch, tool, "SELECT uniqExact(session_id) AS runs, uniqExact(operator_code) AS operators FROM spatial_events WHERE scenario_id = {scenario:String} AND dag_version = {version:String} AND event_type = 'session_completed'", { scenario: args.scenario, version: args.dagVersion });
  return { runs: n(row?.runs), operators: n(row?.operators) };
}

export const tools: { [K in ToolName]: (ch: ClickHouseClient, args: ToolArgs) => Promise<NonNullable<ToolResults[K]>> } = {
  async operatorMistakes(ch, args) {
    const params = { scenario: args.scenario, operator: args.operator, kinds: CORRECTION_KINDS };
    const [summary] = await rows(ch, "operatorMistakes", "SELECT uniqExact(session_id) AS runs, argMax(session_id, at) AS last_session FROM spatial_events WHERE scenario_id = {scenario:String} AND operator_code = {operator:String} AND event_type = 'session_completed'", params);
    const lastSessionId = args.sessionId || String(summary?.last_session ?? "");
    const list = await rows(ch, "operatorMistakes", `SELECT ${REQUIRED} AS required_part_id, ${STEP} AS step_id, part_id, event_type AS kind, count() AS corrections, uniqExact(session_id) AS runs, countIf(session_id = {session:String}) AS in_last_run FROM spatial_events WHERE scenario_id = {scenario:String} AND operator_code = {operator:String} AND event_type IN {kinds:Array(String)} GROUP BY required_part_id, step_id, part_id, kind ORDER BY in_last_run DESC, runs DESC, corrections DESC LIMIT 50`, { ...params, session: lastSessionId });
    return { operator: args.operator, runs: n(summary?.runs), lastSessionId, mistakes: list.filter((row) => knownParts(args.scenario, row.step_id, row.part_id, row.required_part_id)).map((row) => ({ stepId: String(row.step_id), partId: String(row.part_id), kind: String(row.kind), requiredPartId: String(row.required_part_id ?? ""), corrections: n(row.corrections), runs: n(row.runs), inLastRun: n(row.in_last_run) })) };
  },
  async stepErrorRates(ch, args) {
    const total = await totals(ch, "stepErrorRates", args);
    const list = await rows(ch, "stepErrorRates", `SELECT ${STEP} AS step_id, event_type AS kind, uniqExact(session_id) AS runs_with_error, uniqExact(operator_code) AS operators, count() AS corrections FROM spatial_events WHERE scenario_id = {scenario:String} AND dag_version = {version:String} AND event_type IN {kinds:Array(String)} AND ${COMPLETED(true)} GROUP BY step_id, kind ORDER BY runs_with_error DESC, corrections DESC LIMIT 50`, { scenario: args.scenario, version: args.dagVersion, kinds: CORRECTION_KINDS });
    return list.filter((row) => row.step_id && knownParts(args.scenario, row.step_id)).map((row) => ({ stepId: String(row.step_id), kind: String(row.kind), runsWithError: n(row.runs_with_error), operators: n(row.operators), corrections: n(row.corrections), totalRuns: total.runs, totalOperators: total.operators, rate: rate(n(row.runs_with_error), total.runs) }));
  },
  async commonWrongOrder(ch, args) {
    const total = await totals(ch, "commonWrongOrder", args);
    const list = await rows(ch, "commonWrongOrder", `SELECT part_id AS attempted_part_id, ${REQUIRED} AS required_part_id, count() AS attempts, uniqExact(session_id) AS runs, uniqExact(operator_code) AS operators FROM spatial_events WHERE scenario_id = {scenario:String} AND dag_version = {version:String} AND event_type = 'out_of_sequence_pick' AND ${COMPLETED(true)} GROUP BY attempted_part_id, required_part_id ORDER BY runs DESC, attempts DESC LIMIT 10`, { scenario: args.scenario, version: args.dagVersion });
    return list.filter((row) => knownParts(args.scenario, row.attempted_part_id, row.required_part_id)).map((row) => ({ attemptedPartId: String(row.attempted_part_id), requiredPartId: String(row.required_part_id), attempts: n(row.attempts), runs: n(row.runs), operators: n(row.operators), totalRuns: total.runs, rate: rate(n(row.runs), total.runs) }));
  },
  async hesitationByStep(ch, args) {
    const list = await rows(ch, "hesitationByStep", `SELECT part_id AS step_id, round(quantileExact(0.5)(ms)) AS median_ms, count() AS samples FROM (SELECT session_id, part_id, toUnixTimestamp64Milli(maxIf(at, event_type = 'placement_verified')) - toUnixTimestamp64Milli(minIf(at, event_type = 'pickup_started')) AS ms FROM spatial_events WHERE scenario_id = {scenario:String} AND part_id != '' AND event_type IN ('pickup_started', 'placement_verified') GROUP BY session_id, part_id HAVING countIf(event_type = 'pickup_started') > 0 AND countIf(event_type = 'placement_verified') > 0) WHERE ms >= 0 GROUP BY step_id ORDER BY median_ms DESC`, { scenario: args.scenario });
    return list.filter((row) => knownParts(args.scenario, row.step_id)).map((row) => ({ stepId: String(row.step_id), medianMs: n(row.median_ms), samples: n(row.samples) }));
  },
  async versionComparison(ch, args) {
    const params = { scenario: args.scenario, kinds: CORRECTION_KINDS };
    const [runs, errors] = await Promise.all([
      rows(ch, "versionComparison", "SELECT dag_version, uniqExact(session_id) AS runs FROM spatial_events WHERE scenario_id = {scenario:String} AND event_type = 'session_completed' GROUP BY dag_version ORDER BY dag_version", params),
      rows(ch, "versionComparison", `SELECT dag_version, ${STEP} AS step_id, uniqExact(session_id) AS runs_with_error, count() AS corrections FROM spatial_events WHERE scenario_id = {scenario:String} AND event_type IN {kinds:Array(String)} AND ${COMPLETED(false)} GROUP BY dag_version, step_id`, params),
    ]);
    return runs.map((row) => {
      const version = String(row.dag_version), total = n(row.runs);
      return { version, runs: total, steps: errors.filter((item) => String(item.dag_version) === version && item.step_id && knownParts(args.scenario, item.step_id)).map((item) => ({ stepId: String(item.step_id), runsWithError: n(item.runs_with_error), corrections: n(item.corrections), rate: rate(n(item.runs_with_error), total) })) };
    });
  },
};

export async function runTool<K extends ToolName>(ch: ClickHouseClient, name: K, args: ToolArgs): Promise<NonNullable<ToolResults[K]>> { return tools[name](ch, args) as Promise<NonNullable<ToolResults[K]>>; }
