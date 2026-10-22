import { randomUUID } from "node:crypto";
import { z } from "zod";
import { isUuid, postgres } from "@/lib/db/postgres";
import { allowLlmCall, valkey, VALKEY_KEYS, withTimeout, type CriticJob } from "@/lib/db/valkey";
import { errorMessage } from "@/lib/db/tls";
import { forgeKey, isScenarioSlug, loadForgeScenario } from "@/lib/forge/memory";
import { getScenario, saveScenario } from "@/lib/forge/repo";
import { validateScenario } from "@/lib/forge/validate";
import type { ForgeScenario, ForgeStep, MistakeReason } from "@/lib/forge/types";
import { invalidateForgeCoach, REASON_PHRASE } from "./coach-forge";
import { stepStruggles, type StepStruggle } from "./forge-analytics";
import { completeJson, llmConfigured } from "./llm";

// Forge Critic: after a completed session, find steps where at least 30% of completed runs (and at least 5 runs) on
// the current published version had a mistake, and propose better hint / warning / voice line text for them.
// The threshold and evidence are computed here; the LLM only writes text. Approval publishes version + 1.
export const FORGE_THRESHOLD = { minRate: 0.3, minRuns: 5 };
const MAX_PER_RUN = 3;

export type ForgeStepChange = { hint?: string; warning?: string; voiceLine?: string; instruction?: string };
export type ForgeProposalRow = {
  id: string; scenario_id: string; based_on_version: string; step_id: string; kind: string; source: "llm" | "rules"; model: string | null; rationale: string;
  evidence: Record<string, unknown>; guidance: { forge: true; steps: Record<string, ForgeStepChange> }; status: "pending" | "approved" | "rejected";
  created_at: string; reviewed_at: string | null; reviewed_by: string | null; approved_version: string | null;
};
export type ForgeCriticOutcome = {
  ok: boolean; forge: true; error?: string; scenario: string; operator: string; sessionId?: string; version: string; source: "llm" | "rules"; llmError?: string;
  candidates: StepStruggle[]; proposals: Array<{ id: string; stepId: string; kind: string; source: "llm" | "rules"; rationale: string }>;
  proposal: { id: string; stepId: string; kind: string; source: "llm" | "rules"; rationale: string } | null; proposalSkipped?: string;
  profile: { updated: boolean; summary: string }; toolsCalled: string[];
};

const pct = (value: number) => `${Math.round(value * 100)}%`;
const g = globalThis as typeof globalThis & { __sfForgeProposals?: ForgeProposalRow[] };
const memProposals = () => (g.__sfForgeProposals ??= []);
export const isForgeScenarioKey = (value: unknown): value is string => typeof value === "string" && value.startsWith("forge:") && isScenarioSlug(value.slice(6));

const partName = (scenario: ForgeScenario, step: ForgeStep) => scenario.parts.find((part) => step.partIds.includes(part.id))?.name ?? "part";
const titleOf = (scenario: ForgeScenario, id: string) => scenario.steps.find((step) => step.id === id)?.title ?? id;

export function forgeEvidenceLine(scenario: ForgeScenario, candidate: StepStruggle) {
  return `${candidate.runsWithError} of ${candidate.totalRuns} completed runs (${pct(candidate.rate)}) on v${scenario.version} had a mistake at "${titleOf(scenario, candidate.stepId)}", mostly: ${REASON_PHRASE[candidate.dominantReason]}; ${candidate.operators} of ${candidate.totalOperators} operators, ${candidate.corrections} corrections${candidate.medianMs ? `, median ${(candidate.medianMs / 1000).toFixed(1)} s on the step` : ""}. Threshold: at least ${pct(FORGE_THRESHOLD.minRate)} of runs and ${FORGE_THRESHOLD.minRuns} runs.`;
}

// Deterministic text when no LLM is configured or its output is invalid.
export function rulesChange(scenario: ForgeScenario, step: ForgeStep, candidate: StepStruggle): ForgeStepChange {
  const part = partName(scenario, step).toLowerCase(), rate = pct(candidate.rate);
  const before = step.requires.map((id) => titleOf(scenario, id).toLowerCase()).join(" and ") || "the previous step";
  const byReason: Record<MistakeReason, ForgeStepChange> = {
    orientation: { hint: `Find the key or flat on the ${part} and line it up with its slot before you insert it.`, warning: `${rate} of runs had the ${part} turned the wrong way here. Check the key before you push.`, voiceLine: `Line up the key on the ${part} first, then slide it in.` },
    position: { hint: `Keep the ${part} square to its axis and slide it in until it stops.`, warning: `${rate} of runs missed the seat on this step. Push the ${part} fully home.`, voiceLine: `Slide the ${part} straight in until it seats.` },
    "out-of-order": { hint: `Finish ${before} before this step.`, warning: `${rate} of runs tried this step too early. Complete ${before} first.`, voiceLine: `Finish ${before} first, then fit the ${part}.` },
    "wrong-part": { hint: `This step needs the ${part}. Check the name on the card before you pick up.`, warning: `${rate} of runs picked up the wrong part here.`, voiceLine: `Pick up the ${part} for this step.` },
    "wrong-tool": { hint: step.tool ? `Use the ${step.tool} for this step.` : "Check the tool on the card before you start.", warning: `${rate} of runs used the wrong tool here.`, voiceLine: step.tool ? `Grab the ${step.tool} for this one.` : "Check the tool before you start." },
    "out-of-range": { hint: step.target ? `Set ${step.target.label} to ${step.target.value} ${step.target.unit}${step.target.tolerance ? `, within ${step.target.tolerance} ${step.target.unit}` : ""}.` : "Read the target value before you adjust.", warning: `${rate} of runs set this value out of range.`, voiceLine: step.target ? `Aim for ${step.target.value} ${step.target.unit}.` : "Check the target value before you adjust." },
    blocked: { hint: `Clear the path for the ${part} before you insert it.`, warning: `${rate} of runs were blocked here by another part.`, voiceLine: `Make sure nothing blocks the ${part}, then insert it.` },
    "not-confirmed": { hint: "Go through each checklist item, then confirm the step.", warning: `${rate} of runs skipped the confirmation here.`, voiceLine: "Check each item, then confirm the step." },
  };
  return byReason[candidate.dominantReason];
}

const text = (max: number) => z.string().min(1).max(max);
const changeSchema = z.object({ stepId: z.string(), rationale: text(900), hint: text(220), warning: text(220), voiceLine: text(160), instruction: text(400).optional() });
const decisionSchema = z.object({ proposals: z.array(changeSchema).max(MAX_PER_RUN) });

async function llmChanges(scenario: ForgeScenario, candidates: StepStruggle[]) {
  const steps = candidates.map((candidate) => {
    const step = scenario.steps.find((item) => item.id === candidate.stepId)!;
    return { stepId: step.id, kind: step.kind, title: step.title, instruction: step.instruction, voiceLine: step.voiceLine, hints: step.hints ?? [], warnings: step.warnings ?? [], commonMistakes: step.commonMistakes ?? [], tool: step.tool, target: step.target, parts: scenario.parts.filter((part) => step.partIds.includes(part.id)).map((part) => ({ name: part.name, category: part.category, mate: part.mate.type, keyed: (part.mate.symmetryDeg ?? 360) >= 360 })), evidence: { ...candidate, meaning: forgeEvidenceLine(scenario, candidate) } };
  });
  return completeJson("forge-critic", decisionSchema, [
    { role: "system", content: "You are the Critic agent for SpatialForge, a mechanical and mechatronic assembly trainer. Group analytics show steps where many technicians make the same mistake. For each step you rewrite the guidance so that mistake stops happening: one concrete hint, one short warning that names the risk, and a new spoken voice line (imperative, under 20 words, no ids or numbers that are not physical values). Optionally tighten the on-screen instruction. Placement correctness, order and tolerances are deterministic and out of scope: never change them. Cite the evidence numbers in the rationale. Reply with a single JSON object only." },
    { role: "user", content: `Scenario: ${JSON.stringify({ id: scenario.id, title: scenario.title, version: scenario.version, domain: scenario.domain })}\nSteps that passed the threshold: ${JSON.stringify(steps)}\n\nReply {"proposals": [{"stepId": "...", "rationale": "...", "hint": "...", "warning": "...", "voiceLine": "...", "instruction": "... (optional)"}]} with one entry per step above, using the exact stepId.` },
  ], { maxTokens: 3000, timeoutMs: 60000 });
}

async function existingSteps(scenarioKey: string, version: string): Promise<Set<string>> {
  const db = postgres();
  if (!db) return new Set(memProposals().filter((row) => row.scenario_id === scenarioKey && row.based_on_version === version).map((row) => row.step_id));
  const { rows } = await db.query("select step_id from agent_proposals where scenario_id = $1 and based_on_version = $2", [scenarioKey, version]);
  return new Set(rows.map((row) => String(row.step_id)));
}

export async function runForgeCritic(input: { scenarioId: string; operator?: string; sessionId?: string }): Promise<ForgeCriticOutcome> {
  const scenarioKey = forgeKey(input.scenarioId);
  const outcome: ForgeCriticOutcome = { ok: false, forge: true, scenario: scenarioKey, operator: input.operator ?? "", sessionId: input.sessionId, version: "", source: "rules", candidates: [], proposals: [], proposal: null, profile: { updated: false, summary: "Forge profiles are updated when the session completes." }, toolsCalled: ["stepStruggles"] };
  try {
    const scenario = await loadForgeScenario(input.scenarioId);
    if (!scenario) return { ...outcome, error: `scenario ${input.scenarioId} not found` };
    const version = String(scenario.version);
    outcome.version = version;
    const struggles = await stepStruggles(input.scenarioId, version);
    const qualified = struggles.filter((row) => row.rate >= FORGE_THRESHOLD.minRate && row.runsWithError >= FORGE_THRESHOLD.minRuns && scenario.steps.some((step) => step.id === row.stepId));
    outcome.candidates = qualified;
    const taken = await existingSteps(scenarioKey, version);
    const fresh = qualified.filter((row) => !taken.has(row.stepId)).slice(0, MAX_PER_RUN);
    if (!qualified.length) return { ...outcome, ok: true, proposalSkipped: struggles.length ? `no step passed the threshold on v${version} (top: ${pct(struggles[0].rate)} of ${struggles[0].totalRuns} runs)` : `no completed runs with mistakes on v${version}` };
    if (!fresh.length) return { ...outcome, ok: true, proposalSkipped: `every qualifying step already has a proposal on v${version}` };
    const drafts = new Map<string, ForgeStepChange & { rationale: string; source: "llm" | "rules"; model?: string }>();
    if (llmConfigured() && await allowLlmCall(valkey(), "forge-critic", 20)) {
      const llm = await llmChanges(scenario, fresh);
      if (llm.ok) for (const item of llm.data.proposals) {
        const candidate = fresh.find((row) => row.stepId === item.stepId);
        if (candidate && !drafts.has(item.stepId)) drafts.set(item.stepId, { hint: item.hint, warning: item.warning, voiceLine: item.voiceLine, instruction: item.instruction, rationale: `${item.rationale}\n\nEvidence (ClickHouse): ${forgeEvidenceLine(scenario, candidate)}`, source: "llm", model: llm.model });
      }
      else outcome.llmError = llm.error;
    } else if (llmConfigured()) outcome.llmError = "LLM rate limit reached; used rules";
    for (const candidate of fresh) if (!drafts.has(candidate.stepId)) {
      const step = scenario.steps.find((item) => item.id === candidate.stepId)!;
      drafts.set(candidate.stepId, { ...rulesChange(scenario, step, candidate), rationale: `Group pattern at "${step.title}": ${forgeEvidenceLine(scenario, candidate)}`, source: "rules" });
    }
    outcome.source = [...drafts.values()].some((draft) => draft.source === "llm") ? "llm" : "rules";
    const db = postgres();
    for (const candidate of fresh) {
      const draft = drafts.get(candidate.stepId)!;
      const change: ForgeStepChange = { hint: draft.hint, warning: draft.warning, voiceLine: draft.voiceLine, ...(draft.instruction ? { instruction: draft.instruction } : {}) };
      const evidence = { forge: true, pattern: { ...candidate, dagVersion: version }, threshold: FORGE_THRESHOLD, operator: input.operator ?? null, sessionId: input.sessionId ?? null, toolsCalled: outcome.toolsCalled };
      const guidance = { forge: true as const, steps: { [candidate.stepId]: change } };
      let id: string | null = null;
      if (db) {
        const inserted = await db.query("insert into agent_proposals (scenario_id, based_on_version, rationale, evidence, guidance, step_id, kind, source, model, session_id) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict do nothing returning id", [scenarioKey, version, draft.rationale, evidence, guidance, candidate.stepId, candidate.dominantReason, draft.source, draft.model ?? null, isUuid(input.sessionId) ? input.sessionId : null]);
        id = inserted.rows[0]?.id ?? null;
      } else {
        id = randomUUID();
        memProposals().push({ id, scenario_id: scenarioKey, based_on_version: version, step_id: candidate.stepId, kind: candidate.dominantReason, source: draft.source, model: draft.model ?? null, rationale: draft.rationale, evidence, guidance, status: "pending", created_at: new Date().toISOString(), reviewed_at: null, reviewed_by: null, approved_version: null });
      }
      if (id) outcome.proposals.push({ id, stepId: candidate.stepId, kind: candidate.dominantReason, source: draft.source, rationale: draft.rationale });
    }
    outcome.proposal = outcome.proposals[0] ?? null;
    if (!outcome.proposal) outcome.proposalSkipped = "proposals for these steps were created concurrently";
    return { ...outcome, ok: true };
  } catch (error) {
    console.error("critic-forge: run failed", errorMessage(error));
    return { ...outcome, error: errorMessage(error).slice(0, 300) };
  }
}

// Queues a Critic job for a completed Forge session (same reliable queue as the legacy Critic). Returns false without Valkey.
export async function enqueueForgeCritic(job: { scenarioId: string; version: number; operatorId: string; sessionId: string; completedAt: string }): Promise<boolean> {
  const cache = valkey();
  if (!cache) return false;
  const payload: CriticJob = { sessionId: job.sessionId, operator: job.operatorId, scenario: forgeKey(job.scenarioId), dagVersion: String(job.version), completedAt: job.completedAt, queuedAt: new Date().toISOString() };
  try { await withTimeout(cache.lpush(VALKEY_KEYS.criticQueue, JSON.stringify(payload))); return true; }
  catch (error) { console.error("critic-forge: enqueue failed", errorMessage(error)); return false; }
}

// ---------- review ----------
export async function listForgeProposals(scenarioKey: string, status?: string | null): Promise<ForgeProposalRow[]> {
  const db = postgres();
  const filter = status && ["pending", "approved", "rejected"].includes(status) ? status : null;
  if (!db) return memProposals().filter((row) => row.scenario_id === scenarioKey && (!filter || row.status === filter)).reverse();
  const { rows } = await db.query("select id, scenario_id, based_on_version, step_id, kind, source, model, rationale, evidence, guidance, status, created_at, reviewed_at, reviewed_by, approved_version from agent_proposals where scenario_id = $1 and ($2::text is null or status = $2) order by (status = 'pending') desc, created_at desc limit 50", [scenarioKey, filter]);
  return rows as ForgeProposalRow[];
}

export function applyChange(step: ForgeStep, change: ForgeStepChange, note?: string): ForgeStep {
  const front = (value: string | undefined, list: string[] | undefined) => value ? [value, ...(list ?? []).filter((item) => item !== value)].slice(0, 4) : list;
  const next: ForgeStep = { ...step, hints: front(change.hint, step.hints), warnings: front(change.warning, step.warnings), voiceLine: change.voiceLine?.trim() || step.voiceLine, instruction: change.instruction?.trim() || step.instruction };
  if (note) next.commonMistakes = front(note, step.commonMistakes);
  if (change.voiceLine && change.voiceLine !== step.voiceLine) delete next.audio; // cached audio no longer matches the text
  return next;
}

export type ForgeReviewResult = { ok: true; status: "approved" | "rejected"; id: string; scenario?: string; version?: number; previousVersion?: number; cacheKeysInvalidated?: number } | { ok: false; status: number; error: string };

// Approve: apply the proposed text to the latest published scenario and publish it as version + 1 (next sessions get it).
export async function reviewForgeProposal(id: string, action: "approve" | "reject", reviewer: string): Promise<ForgeReviewResult> {
  const db = postgres();
  let row: ForgeProposalRow | undefined;
  if (db) {
    // Claim the proposal first so two reviewers cannot both publish it.
    const claimed = await db.query("update agent_proposals set status = $2, reviewed_at = now(), reviewed_by = $3 where id = $1 and status = 'pending' and scenario_id like 'forge:%' returning id, scenario_id, based_on_version, step_id, kind, guidance, evidence", [id, action === "approve" ? "approved" : "rejected", reviewer]);
    row = claimed.rows[0];
    if (!row) {
      const { rows } = await db.query("select status from agent_proposals where id = $1", [id]);
      return rows[0] ? { ok: false, status: 409, error: `Proposal is already ${rows[0].status}` } : { ok: false, status: 404, error: "Proposal not found" };
    }
  } else {
    row = memProposals().find((item) => item.id === id);
    if (!row) return { ok: false, status: 404, error: "Proposal not found" };
    if (row.status !== "pending") return { ok: false, status: 409, error: `Proposal is already ${row.status}` };
    row.status = action === "approve" ? "approved" : "rejected"; row.reviewed_at = new Date().toISOString(); row.reviewed_by = reviewer;
  }
  if (action === "reject") return { ok: true, status: "rejected", id };
  const revert = async (error: string, status = 409): Promise<ForgeReviewResult> => {
    if (db) await db.query("update agent_proposals set status = 'pending', reviewed_at = null, reviewed_by = null where id = $1", [id]).catch(() => undefined);
    else if (row) { row.status = "pending"; row.reviewed_at = null; row.reviewed_by = null; }
    return { ok: false, status, error };
  };
  try {
    const scenarioId = row.scenario_id.slice(6);
    const base = await loadForgeScenario(scenarioId);
    if (!base) return revert("Scenario not found");
    const step = base.steps.find((item) => item.id === row!.step_id);
    if (!step) return revert(`Step ${row.step_id} no longer exists in ${scenarioId} v${base.version}`);
    const change = (row.guidance as ForgeProposalRow["guidance"])?.steps?.[row.step_id] ?? {};
    const pattern = (row.evidence as { pattern?: StepStruggle })?.pattern;
    const note = pattern ? `Group data v${row.based_on_version}: ${pct(pattern.rate)} of runs ${REASON_PHRASE[pattern.dominantReason] ?? "made a mistake"} here.` : undefined;
    const latest = await getScenario(scenarioId);
    const version = Math.max(base.version, latest?.version ?? 0) + 1;
    const next: ForgeScenario = { ...base, version, status: "published", steps: base.steps.map((item) => item.id === step.id ? applyChange(item, change, note) : item), updatedAt: new Date().toISOString() };
    const issues = validateScenario(next);
    if (issues.length) return revert(`The updated scenario does not validate: ${issues.slice(0, 3).join(" ")}`);
    await saveScenario({ ...next, issues: [] }, reviewer);
    if (db) await db.query("update agent_proposals set approved_version = $2 where id = $1", [id, String(version)]);
    else row.approved_version = String(version);
    const invalidated = await invalidateForgeCoach(scenarioId);
    return { ok: true, status: "approved", id, scenario: row.scenario_id, version, previousVersion: base.version, cacheKeysInvalidated: invalidated };
  } catch (error) {
    console.error("critic-forge: approval failed", errorMessage(error));
    return revert("Publishing the new version failed", 502);
  }
}

export const isForgeProposalId = (id: string) => isUuid(id);
