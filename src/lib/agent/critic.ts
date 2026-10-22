import { createHash } from "node:crypto";
import { z } from "zod";
import { getScenario, partFor, type PartDefinition, type PartId, type ScenarioId } from "@/lib/assembly";
import { cleanGuidance, type Guidance, type StepGuidance } from "@/lib/guidance";
import { clickhouse } from "@/lib/db/clickhouse";
import { postgres } from "@/lib/db/postgres";
import { allowLlmCall, valkey, VALKEY_KEYS, withTimeout, type CriticJob } from "@/lib/db/valkey";
import { errorMessage } from "@/lib/db/tls";
import { activeGuidance, isOperator, isScenario } from "./guidance-store";
import { completeJson, llmConfigured, type ChatMessage } from "./llm";
import { runTool, TOOL_DESCRIPTIONS, TOOL_NAMES, type OperatorMistakes, type StepRate, type ToolArgs, type ToolName, type ToolResults, type WrongOrder } from "./tools";

// Critic agent: reads one operator's history and cross-operator patterns from ClickHouse, updates the
// operator's long-term profile, and proposes guidance changes when a pattern passes the threshold.
// The threshold check and evidence numbers are always computed here; the LLM only picks extra tools and
// writes the rationale and guidance text. Without a key (or when the LLM fails) deterministic rules do it.
export const THRESHOLD = { minRate: 0.3, minRuns: 5 };
const PROPOSABLE_KINDS = new Set(["out_of_sequence_pick", "wrong-target", "orientation", "prerequisite"]);
const EXTRA_TOOLS = TOOL_NAMES.filter((name) => name !== "operatorMistakes" && name !== "stepErrorRates") as ToolName[];

export type CriticInput = { scenario: ScenarioId; operator: string; sessionId?: string };
export type Candidate = StepRate & { part: PartDefinition; wrongOrder?: WrongOrder };
export type ProposalDraft = { stepId: PartId; kind: string; rationale: string; guidance: Guidance; source: "llm" | "rules"; model?: string };
export type CriticOutcome = {
  ok: boolean; error?: string; scenario: ScenarioId; operator: string; sessionId?: string; version: string; source: "llm" | "rules";
  toolsCalled: ToolName[]; llmError?: string; candidates: Array<Omit<Candidate, "part">>;
  profile: { updated: boolean; summary: string };
  proposal: { id: string; stepId: string; kind: string; source: "llm" | "rules"; rationale: string } | null; proposalSkipped?: string;
};

const pct = (value: number) => `${Math.round(value * 100)}%`;
const shortOf = (scenario: ScenarioId, id: string) => partFor(scenario, id as PartId)?.short ?? "part";

export function qualifying(scenario: ScenarioId, rates: StepRate[], wrongOrder: WrongOrder[] = []): Candidate[] {
  return rates.filter((row) => PROPOSABLE_KINDS.has(row.kind) && row.rate >= THRESHOLD.minRate && row.runsWithError >= THRESHOLD.minRuns && partFor(scenario, row.stepId as PartId))
    .map((row) => ({ ...row, part: partFor(scenario, row.stepId as PartId)!, wrongOrder: row.kind === "out_of_sequence_pick" ? wrongOrder.find((item) => item.requiredPartId === row.stepId) : undefined }))
    .sort((a, b) => b.rate - a.rate || b.runsWithError - a.runsWithError);
}

export function evidenceLine(scenario: ScenarioId, version: string, candidate: Candidate) {
  const { part, wrongOrder } = candidate;
  const what = candidate.kind === "out_of_sequence_pick" ? `picked the ${wrongOrder ? shortOf(scenario, wrongOrder.attemptedPartId) : "wrong part"} before fitting the ${part.short}`
    : candidate.kind === "orientation" ? `released the ${part.short} at the wrong rotation (required ${part.requiredRotation}°)`
    : candidate.kind === "wrong-target" ? `released the ${part.short} over the wrong target (correct target ${part.target})`
    : `tried to place the ${part.short} before its prerequisite`;
  return `${candidate.runsWithError} of ${candidate.totalRuns} ${scenario} runs (${pct(candidate.rate)}) on v${version} ${what}, across ${candidate.operators} of ${candidate.totalOperators} operators (${candidate.corrections} corrections). Threshold: at least ${pct(THRESHOLD.minRate)} of runs and ${THRESHOLD.minRuns} runs.`;
}

// Deterministic guidance for a qualifying pattern; used when no LLM is configured or its output is invalid.
export function rulesProposal(scenario: ScenarioId, version: string, candidate: Candidate): ProposalDraft {
  const { part, wrongOrder } = candidate;
  const prerequisites = part.prerequisites.map((id) => shortOf(scenario, id)).join(" and ");
  let step: StepGuidance;
  if (candidate.kind === "out_of_sequence_pick") {
    const attempted = wrongOrder ? shortOf(scenario, wrongOrder.attemptedPartId) : "next part";
    step = { preWarning: `Fit the ${part.short} before the ${attempted}. ${pct(candidate.rate)} of recent runs reached for the ${attempted} too early.`, hint: `${part.short} first: ${part.cue.charAt(0).toLowerCase()}${part.cue.slice(1)}`, voiceLine: `Before you reach for the ${attempted}, fit the ${part.short}.` };
  } else if (candidate.kind === "orientation") {
    step = { preWarning: `Rotate the ${part.short} to ${part.requiredRotation}° before you release it.`, hint: `${part.cue}. Required rotation ${part.requiredRotation}°`, voiceLine: `Check the ${part.short} is turned to ${part.requiredRotation} degrees before placing it.`, substeps: [`Pick up the ${part.short}`, `Rotate to ${part.requiredRotation}°`, `Release over ${part.target}`] };
  } else if (candidate.kind === "wrong-target") {
    step = { preWarning: `The ${part.short} goes in ${part.target}. Check the target label before releasing.`, hint: `${part.cue}. Target ${part.target}`, voiceLine: `Carry the ${part.short} to target ${part.target}.` };
  } else {
    step = { preWarning: `Place the ${prerequisites || "earlier parts"} before the ${part.short}.`, hint: `${part.cue}. Needs ${prerequisites || "the previous step"} first`, voiceLine: `The ${part.short} comes after the ${prerequisites || "previous part"}.` };
  }
  return { stepId: part.id, kind: candidate.kind, rationale: `Cross-operator pattern on ${part.short}: ${evidenceLine(scenario, version, candidate)}`, guidance: { steps: { [part.id]: step } }, source: "rules" };
}

const MISTAKE_TEXT: Record<string, (scenario: ScenarioId, m: OperatorMistakes["mistakes"][number]) => string> = {
  out_of_sequence_pick: (s, m) => `picked the ${shortOf(s, m.partId)} before the ${shortOf(s, m.requiredPartId || m.stepId)}`,
  orientation: (s, m) => `placed the ${shortOf(s, m.partId)} at the wrong rotation`,
  "wrong-target": (s, m) => `released the ${shortOf(s, m.partId)} over the wrong target`,
  prerequisite: (s, m) => `tried the ${shortOf(s, m.partId)} before its prerequisite`,
  "tracking-lost": (s, m) => `lost hand tracking while holding the ${shortOf(s, m.partId)}`,
};
export function profileSummary(scenario: ScenarioId, history: OperatorMistakes) {
  if (!history.runs) return `No completed ${scenario} runs yet.`;
  const top = history.mistakes.filter((m) => MISTAKE_TEXT[m.kind]).slice(0, 3);
  if (!top.length) return `${history.runs} completed ${scenario} runs with no corrections.`;
  return `Over ${history.runs} ${scenario} runs: ${top.map((m) => `${MISTAKE_TEXT[m.kind](scenario, m)} in ${m.runs} run${m.runs === 1 ? "" : "s"}${m.inLastRun ? " (including the latest)" : ""}`).join("; ")}.`;
}

const stepSchema = z.object({ preWarning: z.string().min(1).max(240).optional(), hint: z.string().min(1).max(240).optional(), voiceLine: z.string().min(1).max(240).optional(), substeps: z.array(z.string().min(1).max(140)).max(5).optional() }).strict().refine((step) => Object.keys(step).length > 0, "guidance needs at least one field");
const planSchema = z.object({ tools: z.array(z.enum(EXTRA_TOOLS as [ToolName, ...ToolName[]])).max(EXTRA_TOOLS.length), reason: z.string().max(600).optional() });
const decisionSchema = z.object({ operatorSummary: z.string().min(1).max(500), proposal: z.object({ stepId: z.string(), kind: z.string(), rationale: z.string().min(1).max(900), guidance: stepSchema }).nullable() });

function context(input: CriticInput, version: string, guidance: Guidance) {
  const parts = getScenario(input.scenario).parts.map((part) => ({ id: part.id, name: part.name, short: part.short, cue: part.cue, target: part.target, requiredRotation: part.requiredRotation, prerequisites: part.prerequisites }));
  return { scenario: input.scenario, operator: input.operator, activeVersion: version, parts, currentGuidance: guidance.steps, threshold: THRESHOLD };
}
const SYSTEM = "You are the Critic agent for SpatialForge, a guided assembly trainer. You analyse correction data from fixed ClickHouse query tools (you never write SQL) and improve instruction text. Placement correctness is deterministic and out of scope: you may only change the guidance fields preWarning, hint, voiceLine, and substeps for a step. Keep each text short, concrete, and addressed to a technician. Reply with a single JSON object only.";

async function llmCritic(input: CriticInput, version: string, guidance: Guidance, results: ToolResults, run: (name: ToolName) => Promise<void>, candidates: () => Candidate[]) {
  const base = context(input, version, guidance);
  const plan = await completeJson("critic-plan", planSchema, [
    { role: "system", content: SYSTEM },
    { role: "user", content: `Context: ${JSON.stringify(base)}\n\nBaseline tool results:\n${JSON.stringify({ operatorMistakes: results.operatorMistakes, stepErrorRates: results.stepErrorRates })}\n\nYou may call more tools before deciding. Available: ${JSON.stringify(Object.fromEntries(EXTRA_TOOLS.map((name) => [name, TOOL_DESCRIPTIONS[name]])))}\nReply {"tools": [names], "reason": "..."}. Choose commonWrongOrder if out-of-order picks look relevant.` },
  ], { maxTokens: 2048, timeoutMs: 45000 });
  if (!plan.ok) return { error: `plan: ${plan.error}` };
  for (const name of plan.data.tools) await run(name);
  const qualified = candidates();
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM },
    { role: "user", content: `Context: ${JSON.stringify(base)}\n\nTool results:\n${JSON.stringify(results)}\n\nPatterns that passed the threshold: ${JSON.stringify(qualified.map(({ part: _part, ...rest }) => ({ ...rest, meaning: evidenceLine(input.scenario, version, { ...rest, part: _part }) })))}\n\nGuidance for a step is shown while that step is the next one to do. For out_of_sequence_pick the step is the part that must be fitted first, and the preWarning must name the part operators grab too early and the part to fit first.\n\nTasks:\n1. operatorSummary: one or two sentences describing this operator's habits by part name, citing counts.\n2. proposal: ${qualified.length ? "pick ONE pattern from the qualifying list (use its exact stepId and kind) and write guidance for that step that directly prevents that mistake. The rationale must cite the evidence numbers (runs with the error, total runs, operators)." : "null, because no pattern without an existing proposal passed the threshold."}\nReply {"operatorSummary": "...", "proposal": {"stepId": "...", "kind": "...", "rationale": "...", "guidance": {"preWarning": "...", "hint": "...", "voiceLine": "...", "substeps": ["..."]}} | null}` },
  ];
  const decision = await completeJson("critic-decide", decisionSchema, messages, { maxTokens: 4096, timeoutMs: 60000 });
  if (!decision.ok) return { error: `decide: ${decision.error}` };
  const chosen = decision.data.proposal ? qualified.find((item) => item.stepId === decision.data.proposal!.stepId && item.kind === decision.data.proposal!.kind) : undefined;
  let proposal: ProposalDraft | undefined;
  let error: string | undefined;
  if (chosen && decision.data.proposal) {
    const cleaned = cleanGuidance(input.scenario, { steps: { [chosen.stepId]: decision.data.proposal.guidance } });
    proposal = { stepId: chosen.part.id, kind: chosen.kind, rationale: `${decision.data.proposal.rationale}\n\nEvidence (ClickHouse): ${evidenceLine(input.scenario, version, chosen)}`, guidance: cleaned, source: "llm", model: decision.model };
  } else if (qualified.length) error = decision.data.proposal ? "proposal referenced a pattern that did not pass the threshold" : "no proposal for a qualifying pattern";
  return { summary: decision.data.operatorSummary, proposal, error };
}

export async function runCritic(input: CriticInput): Promise<CriticOutcome> {
  const ch = clickhouse(), db = postgres();
  const active = await activeGuidance(input.scenario, db);
  const outcome: CriticOutcome = { ok: false, scenario: input.scenario, operator: input.operator, sessionId: input.sessionId, version: active.version, source: "rules", toolsCalled: [], candidates: [], profile: { updated: false, summary: "" }, proposal: null };
  if (!ch) return { ...outcome, error: "CLICKHOUSE_URL is not set; the Critic has no event data" };
  const args: ToolArgs = { scenario: input.scenario, operator: input.operator, dagVersion: active.version, sessionId: input.sessionId };
  const results: ToolResults = {};
  const run = async (name: ToolName) => { if (outcome.toolsCalled.includes(name)) return; outcome.toolsCalled.push(name); (results as Record<string, unknown>)[name] = await runTool(ch, name, args); };
  // Patterns that already have a proposal (any status) on this version are not offered again, so the next one gets a turn.
  const proposed = new Set<string>();
  const allQualified = () => qualifying(input.scenario, results.stepErrorRates ?? [], results.commonWrongOrder ?? []);
  const candidates = () => allQualified().filter((item) => !proposed.has(`${item.stepId}/${item.kind}`));
  try {
    if (db) for (const row of (await db.query("select step_id, kind from agent_proposals where scenario_id = $1 and based_on_version = $2", [input.scenario, active.version])).rows) proposed.add(`${row.step_id}/${row.kind}`);
    await Promise.all([run("operatorMistakes"), run("stepErrorRates")]); // baseline; the LLM may add the others
    // Out-of-order evidence (which part was grabbed early) is needed to describe that pattern at all.
    if (allQualified().some((item) => item.kind === "out_of_sequence_pick")) await run("commonWrongOrder");
    let summary = "";
    let draft: ProposalDraft | undefined;
    if (llmConfigured() && await allowLlmCall(valkey(), "critic", 20)) {
      const llm = await llmCritic(input, active.version, active.guidance, results, run, candidates);
      if (llm.summary) summary = llm.summary;
      if (llm.proposal) { draft = llm.proposal; outcome.source = "llm"; }
      if (llm.error) outcome.llmError = llm.error;
      else if (llm.summary && !candidates().length) outcome.source = "llm";
    } else if (llmConfigured()) outcome.llmError = "LLM rate limit reached; used rules";
    const qualified = candidates();
    if (!draft && qualified.length) await run("hesitationByStep"); // extra context stored with rules evidence
    outcome.candidates = allQualified().map(({ part: _part, ...rest }) => rest);
    if (!draft && qualified.length) draft = rulesProposal(input.scenario, active.version, qualified[0]);
    if (!qualified.length && outcome.candidates.length) outcome.proposalSkipped = `every qualifying pattern already has a proposal on v${active.version}`;
    if (!summary) summary = profileSummary(input.scenario, results.operatorMistakes!);
    outcome.profile.summary = summary;
    if (!db) return { ...outcome, ok: true, error: "DATABASE_URL is not set; profile and proposal were not stored", proposal: draft ? { id: "", stepId: draft.stepId, kind: draft.kind, source: draft.source, rationale: draft.rationale } : null };
    const history = results.operatorMistakes!;
    const profile = { runs: history.runs, lastSessionId: history.lastSessionId, lastRun: history.mistakes.filter((m) => m.inLastRun > 0), habits: history.mistakes.slice(0, 8), summary, source: outcome.source, dagVersion: active.version };
    if (input.operator) await db.query("insert into operator_profiles (operator_code, scenario_id, mistakes, updated_at) values ($1,$2,$3,now()) on conflict (operator_code, scenario_id) do update set mistakes = excluded.mistakes, updated_at = now()", [input.operator, input.scenario, profile]);
    outcome.profile.updated = Boolean(input.operator);
    const cache = valkey(); // the operator's Coach briefing must reflect the new profile
    if (cache && input.operator) await withTimeout(cache.del(VALKEY_KEYS.coach(input.scenario, active.version, input.operator))).catch(() => undefined);
    if (draft) {
      const existing = await db.query("select id, status from agent_proposals where scenario_id = $1 and based_on_version = $2 and step_id = $3 and kind = $4 limit 1", [input.scenario, active.version, draft.stepId, draft.kind]);
      if (existing.rows[0]) outcome.proposalSkipped = `a ${existing.rows[0].status} proposal already exists for ${draft.stepId}/${draft.kind} on v${active.version}`;
      else {
        const candidate = qualified.find((item) => item.stepId === draft!.stepId && item.kind === draft!.kind)!;
        const hesitation = results.hesitationByStep?.find((item) => item.stepId === draft!.stepId);
        const evidence = { pattern: { ...candidate, part: undefined, dagVersion: active.version }, wrongOrder: candidate.wrongOrder ?? null, hesitation: hesitation ?? null, threshold: THRESHOLD, toolsCalled: outcome.toolsCalled, operator: input.operator, sessionId: input.sessionId ?? null };
        const inserted = await db.query("insert into agent_proposals (scenario_id, based_on_version, rationale, evidence, guidance, step_id, kind, source, model, session_id) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict do nothing returning id", [input.scenario, active.version, draft.rationale, evidence, draft.guidance, draft.stepId, draft.kind, draft.source, draft.model ?? null, input.sessionId ?? null]);
        if (inserted.rows[0]) outcome.proposal = { id: inserted.rows[0].id, stepId: draft.stepId, kind: draft.kind, source: draft.source, rationale: draft.rationale };
        else outcome.proposalSkipped = "an open proposal for this pattern was created concurrently";
      }
    }
    return { ...outcome, ok: true };
  } catch (error) {
    console.error("critic: run failed", errorMessage(error));
    return { ...outcome, error: errorMessage(error).slice(0, 300) };
  }
}

// Reliable queue: LPUSH by PATCH /api/sessions; here each job is RPOPLPUSHed (oldest first) into a processing list with a
// short claim key and removed only after runCritic returns. A job whose worker died (claim expired) is requeued on the
// next call. Failed jobs go to a side list. New jobs stop starting after a time budget so a request stays within maxDuration.
const CLAIM_SECONDS = 300;
const START_BUDGET_MS = 60000;
const claimKey = (raw: string) => `${VALKEY_KEYS.criticClaim}:${createHash("sha1").update(raw).digest("hex")}`;

async function requeueAbandoned(cache: NonNullable<ReturnType<typeof valkey>>) {
  const processing = await cache.lrange(VALKEY_KEYS.criticProcessing, 0, -1);
  for (const raw of processing) {
    if (await cache.exists(claimKey(raw))) continue;
    // Only the caller that removes the entry requeues it, so concurrent workers cannot duplicate a job.
    if (await cache.lrem(VALKEY_KEYS.criticProcessing, 1, raw)) await cache.rpush(VALKEY_KEYS.criticQueue, raw);
  }
}

export async function processCriticQueue(max = 1): Promise<{ results: CriticOutcome[]; queueEmpty: boolean; queueAvailable: boolean }> {
  const cache = valkey();
  if (!cache) return { results: [], queueEmpty: true, queueAvailable: false };
  const results: CriticOutcome[] = [];
  const startedAt = Date.now();
  await requeueAbandoned(cache).catch((error) => console.error("critic: requeue failed", errorMessage(error)));
  for (let index = 0; index < max && (index === 0 || Date.now() - startedAt < START_BUDGET_MS); index++) {
    const raw = await cache.rpoplpush(VALKEY_KEYS.criticQueue, VALKEY_KEYS.criticProcessing);
    if (!raw) return { results, queueEmpty: true, queueAvailable: true };
    await cache.set(claimKey(raw), "1", "EX", CLAIM_SECONDS).catch(() => undefined);
    const done = () => cache.multi().lrem(VALKEY_KEYS.criticProcessing, 1, raw).del(claimKey(raw)).exec().catch(() => undefined);
    let job: CriticJob;
    try { job = JSON.parse(raw) as CriticJob; } catch { await done(); continue; }
    if (!isScenario(job.scenario) || !isOperator(job.operator)) { await done(); continue; }
    const result = await runCritic({ scenario: job.scenario, operator: job.operator, sessionId: job.sessionId });
    results.push(result);
    if (!result.ok) await cache.lpush(VALKEY_KEYS.criticFailed, JSON.stringify({ ...job, error: result.error, failedAt: new Date().toISOString() })).catch(() => undefined);
    await done();
  }
  return { results, queueEmpty: (await cache.llen(VALKEY_KEYS.criticQueue).catch(() => 0)) === 0, queueAvailable: true };
}
