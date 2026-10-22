import { z } from "zod";
import { getScenario, partFor, type PartId, type ScenarioId } from "@/lib/assembly";
import { cleanGuidance, defaultBriefing, mergeGuidance, type CoachBriefing, type Guidance, type StepGuidance } from "@/lib/guidance";
import { postgres } from "@/lib/db/postgres";
import { allowLlmCall, valkey, VALKEY_KEYS, withTimeout } from "@/lib/db/valkey";
import { errorMessage } from "@/lib/db/tls";
import { activeGuidance } from "./guidance-store";
import { completeJson, llmConfigured } from "./llm";

// Coach agent: active guidance + the operator's profile -> a short personal briefing and per-step hint overrides.
// Approved guidance always wins over personal overrides; personal text only fills fields the version leaves empty.
type Mistake = { stepId: string; partId: string; kind: string; requiredPartId?: string; corrections: number; runs: number; inLastRun?: number };
export type OperatorProfile = { runs?: number; lastRun?: Mistake[]; habits?: Mistake[]; summary?: string };
const CACHE_SECONDS = 6 * 3600, FALLBACK_CACHE_SECONDS = 300;

const shortOf = (scenario: ScenarioId, id?: string) => partFor(scenario, (id || "") as PartId)?.short ?? id ?? "part";

function mistakeAdvice(scenario: ScenarioId, m: Mistake): { said: string; fix: string; step: PartId | null; personal: StepGuidance } {
  const part = partFor(scenario, m.partId as PartId);
  if (m.kind === "out_of_sequence_pick") {
    const required = shortOf(scenario, m.requiredPartId || m.stepId);
    return { said: `picked the ${shortOf(scenario, m.partId)} before the ${required}`, fix: `The ${required} goes in first.`, step: (partFor(scenario, (m.requiredPartId || m.stepId) as PartId)?.id ?? null), personal: { preWarning: `Last time you reached for the ${shortOf(scenario, m.partId)} early. Fit the ${required} first.` } };
  }
  if (m.kind === "orientation") return { said: `placed the ${part?.short ?? m.partId} at the wrong rotation`, fix: `Turn it to ${part?.requiredRotation ?? 0}° before releasing.`, step: part?.id ?? null, personal: { preWarning: `You missed this rotation before: set ${part?.requiredRotation ?? 0}° first.` } };
  if (m.kind === "wrong-target") return { said: `released the ${part?.short ?? m.partId} over the wrong target`, fix: `It belongs in ${part?.target ?? "its own target"}.`, step: part?.id ?? null, personal: { hint: `Target ${part?.target}. ${part?.cue}` } };
  if (m.kind === "prerequisite") return { said: `tried the ${part?.short ?? m.partId} before its prerequisite`, fix: `Place the ${part?.prerequisites.map((id) => shortOf(scenario, id)).join(" and ") || "earlier parts"} first.`, step: part?.id ?? null, personal: {} };
  return { said: `lost hand tracking while holding the ${part?.short ?? m.partId}`, fix: "Keep your hand in view while you carry it.", step: null, personal: {} };
}

export function rulesBriefing(scenario: ScenarioId, operator: string, version: string, guidance: Guidance, profile: OperatorProfile | null): CoachBriefing {
  const base = defaultBriefing(scenario, guidance, version);
  const definition = getScenario(scenario);
  const sentences: string[] = [];
  const personal: Guidance = { steps: {} };
  const last = (profile?.lastRun ?? []).filter((m) => m.kind !== "tracking-lost").sort((a, b) => b.corrections - a.corrections)[0];
  const habit = (profile?.habits ?? []).filter((m) => m.kind !== "tracking-lost" && m.runs >= 2)[0];
  const focus = last ?? habit;
  let focusStep: PartId | null = null;
  if (focus) {
    const advice = mistakeAdvice(scenario, focus);
    sentences.push(last ? `Last time you ${advice.said}. ${advice.fix}` : `You have ${advice.said} in ${focus.runs} of ${profile?.runs ?? focus.runs} runs. ${advice.fix}`);
    focusStep = advice.step;
    if (advice.step && Object.keys(advice.personal).length) personal.steps[advice.step] = advice.personal;
  }
  const warned = (Object.entries(guidance.steps) as Array<[PartId, StepGuidance]>).filter(([, step]) => step.preWarning);
  const update = warned.find(([id]) => id === focusStep) ?? warned[0];
  if (update) sentences.push(`Instructions v${version}: ${update[1].preWarning}`);
  sentences.push(scenario === "tray" ? "Place each shape in its matching target, in any order." : `Begin with the ${definition.parts[0].short}.`);
  const personalized = Boolean(focus || update);
  return { ...base, operator, briefing: personalized ? sentences.join(" ").slice(0, 400) : base.briefing, steps: mergeGuidance(personal, guidance).steps, source: personalized ? "rules" : "default" };
}

const coachSchema = z.object({
  briefing: z.string().min(1).max(400),
  steps: z.record(z.string(), z.object({ hint: z.string().min(1).max(200).optional(), preWarning: z.string().min(1).max(200).optional() }).strict()).default({}),
});

async function llmBriefing(scenario: ScenarioId, operator: string, version: string, guidance: Guidance, profile: OperatorProfile): Promise<CoachBriefing | null> {
  const parts = getScenario(scenario).parts.map((part) => ({ id: part.id, short: part.short, cue: part.cue, target: part.target, requiredRotation: part.requiredRotation, prerequisites: part.prerequisites }));
  const result = await completeJson("coach", coachSchema, [
    { role: "system", content: "You are the Coach agent for SpatialForge, a guided assembly trainer. Before a run you brief one technician in at most three short spoken sentences, based on their past mistakes and the approved instructions. Never change targets, rotations, or order; only give advice. Reply with one JSON object only." },
    { role: "user", content: `Scenario parts: ${JSON.stringify(parts)}\nApproved instructions v${version}: ${JSON.stringify(guidance.steps)}\nOperator ${operator} profile: ${JSON.stringify({ runs: profile.runs, lastRun: (profile.lastRun ?? []).map((m) => mistakeAdvice(scenario, m).said), habits: (profile.habits ?? []).slice(0, 5).map((m) => `${mistakeAdvice(scenario, m).said} in ${m.runs} runs`), summary: profile.summary })}\n\nReply {"briefing": "...", "steps": {"<partId>": {"hint": "...", "preWarning": "..."}}}. Address their most relevant mistake by part name (e.g. "Last time you fitted the gland nut before the spool. Spool goes in first."), mention an approved pre-warning if relevant, and only include step overrides for steps they struggle with.` },
  ], { maxTokens: 2048, timeoutMs: 30000, temperature: 0.4 });
  if (!result.ok) return null;
  const personal = cleanGuidance(scenario, { steps: result.data.steps });
  return { scenario, operator, version, briefing: result.data.briefing, steps: mergeGuidance(personal, guidance).steps, source: "llm", cached: false, persisted: true };
}

export async function coachBriefing(scenario: ScenarioId, operator: string): Promise<CoachBriefing> {
  const db = postgres();
  const active = await activeGuidance(scenario, db);
  if (!db) return { ...defaultBriefing(scenario, active.guidance, active.version), operator };
  const cache = valkey();
  const key = VALKEY_KEYS.coach(scenario, active.version, operator);
  if (cache) {
    try { const hit = await withTimeout(cache.get(key)); if (hit) return { ...JSON.parse(hit) as CoachBriefing, cached: true }; }
    catch (error) { console.error("coach: cache read failed", errorMessage(error)); }
  }
  let profile: OperatorProfile | null = null;
  try { const { rows } = await db.query("select mistakes from operator_profiles where operator_code = $1 and scenario_id = $2", [operator, scenario]); profile = rows[0]?.mistakes ?? null; }
  catch (error) { console.error("coach: profile read failed", errorMessage(error)); }
  let briefing: CoachBriefing | null = null;
  if (profile && llmConfigured() && await allowLlmCall(cache, "coach", 30)) briefing = await llmBriefing(scenario, operator, active.version, active.guidance, profile);
  const fromLlm = Boolean(briefing);
  briefing ??= { ...rulesBriefing(scenario, operator, active.version, active.guidance, profile), persisted: active.persisted };
  // A rules answer given because the LLM failed is cached briefly so the LLM is retried soon.
  const ttl = fromLlm || !llmConfigured() || !profile ? CACHE_SECONDS : FALLBACK_CACHE_SECONDS;
  if (cache) await withTimeout(cache.set(key, JSON.stringify(briefing), "EX", ttl)).catch((error) => console.error("coach: cache write failed", errorMessage(error)));
  return briefing;
}
