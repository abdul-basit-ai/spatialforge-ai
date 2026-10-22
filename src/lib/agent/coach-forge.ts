import { z } from "zod";
import { findOperatorById } from "@/lib/auth";
import { allowLlmCall, valkey } from "@/lib/db/valkey";
import { errorMessage } from "@/lib/db/tls";
import { getProfile, getShortTerm, kvDelPattern, kvGet, kvSet, loadForgeScenario, type ForgeProfile, type ShortTermMemory } from "@/lib/forge/memory";
import type { ForgeScenario, ForgeStep, MistakeReason } from "@/lib/forge/types";
import { forgeAnalytics, type StepStat } from "./forge-analytics";
import { completeJson, llmConfigured } from "./llm";

// Forge Coach: long-term profile + short-term memory + group struggle stats -> a short speakable briefing, one hint per
// focus step, and the focus step ids. Advice only: it never changes order, tolerances or what counts as correct.
export type ForgeCoach = { scenarioId: string; version: number | null; operatorId: string; briefing: string; hints: Record<string, string>; focusSteps: string[]; source: "llm" | "rules" | "default"; model?: string; cached: boolean; basedOn: { runs: number; personalMistakes: number; groupStruggles: number; sessionMistakes: number } };

const CACHE_SECONDS = 6 * 3600, FALLBACK_CACHE_SECONDS = 300;
const coachPrefix = (scenarioId: string) => `sf:forge:coach:${scenarioId}:`;
const coachKey = (scenarioId: string, version: number | null, operatorId: string, runs: number) => `${coachPrefix(scenarioId)}${version ?? 0}:${operatorId || "anon"}:${runs}`;
export const invalidateForgeCoach = (scenarioId: string) => kvDelPattern(coachPrefix(scenarioId));

export const REASON_PHRASE: Record<MistakeReason, string> = {
  "wrong-part": "picked up the wrong part", "out-of-order": "went out of order", position: "missed the seat position", orientation: "had the part turned the wrong way",
  blocked: "was blocked by another part", "wrong-tool": "used the wrong tool", "out-of-range": "set a value out of range", "not-confirmed": "skipped the confirmation",
};
export function reasonTip(step: ForgeStep | undefined, reason: MistakeReason, scenario: ForgeScenario | null): string {
  const part = scenario?.parts.find((item) => step?.partIds.includes(item.id))?.name.toLowerCase() ?? "part";
  switch (reason) {
    case "orientation": return `Line up the key on the ${part} before you push it home.`;
    case "position": return `Slide the ${part} straight along its axis until it seats.`;
    case "out-of-order": return `Check the previous step is done before the ${part}.`;
    case "wrong-part": return `Match the part name on the card before you pick up.`;
    case "wrong-tool": return step?.tool ? `Use the ${step.tool}.` : "Check the tool called for on the card.";
    case "out-of-range": return step?.target ? `Aim for ${step.target.value} ${step.target.unit}.` : "Read the target value before you adjust.";
    case "blocked": return `Clear the path before you insert the ${part}.`;
    default: return "Confirm the step out loud when it is done.";
  }
}

const topReason = (counts: Partial<Record<MistakeReason, number>> | undefined): MistakeReason | null => (Object.entries(counts ?? {}) as Array<[MistakeReason, number]>).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
const sum = (counts: Partial<Record<MistakeReason, number>> | undefined) => Object.values(counts ?? {}).reduce((a, b) => a + (b ?? 0), 0);

type Inputs = { scenario: ForgeScenario | null; scenarioId: string; operatorId: string; name: string | null; profile: ForgeProfile | null; shortTerm: ShortTermMemory | null; group: StepStat[] };

export function rulesCoach(input: Inputs): Omit<ForgeCoach, "cached" | "basedOn"> {
  const { scenario, profile, shortTerm, group } = input;
  const steps = scenario?.steps ?? [];
  const stepOf = (id: string) => steps.find((step) => step.id === id);
  const known = (id: string) => !scenario || Boolean(stepOf(id));
  const personal = Object.entries(profile?.mistakes ?? {}).filter(([id]) => known(id) && id !== "_").map(([id, counts]) => ({ id, total: sum(counts), reason: topReason(counts)! })).filter((item) => item.total > 0).sort((a, b) => b.total - a.total);
  const session = Object.entries(shortTerm?.mistakes ?? {}).filter(([id]) => known(id) && id !== "_").map(([id, counts]) => ({ id, total: sum(counts), reason: topReason(counts)! })).sort((a, b) => b.total - a.total);
  const crowd = group.filter((step) => step.mistakeRate >= 0.3 && step.attempts >= 3);
  const focus: string[] = [];
  for (const id of [...session.map((s) => s.id), ...personal.map((p) => p.id), ...crowd.map((c) => c.stepId)]) if (!focus.includes(id) && focus.length < 3) focus.push(id);
  const hints: Record<string, string> = {};
  for (const id of focus) {
    const step = stepOf(id);
    const reason = session.find((s) => s.id === id)?.reason ?? personal.find((p) => p.id === id)?.reason ?? topReason(group.find((g) => g.stepId === id)?.byReason) ?? "not-confirmed";
    hints[id] = (step?.hints?.[0] ? `${reasonTip(step, reason, scenario)} ${step.hints[0]}` : reasonTip(step, reason, scenario)).slice(0, 200);
  }
  const title = (id: string) => stepOf(id)?.title.toLowerCase() ?? "that step";
  const sentences: string[] = [];
  const first = input.name ? input.name.split(" ")[0] : null;
  if (profile?.runs) {
    const mine = personal[0];
    sentences.push(`${first ? `Welcome back, ${first}.` : "Welcome back."} ${profile.runs} run${profile.runs === 1 ? "" : "s"} so far.`);
    if (mine) sentences.push(`Last time you ${REASON_PHRASE[mine.reason]} at ${title(mine.id)}. ${reasonTip(stepOf(mine.id), mine.reason, scenario)}`);
    else sentences.push("Your last runs were clean. Keep the same pace.");
  } else sentences.push(`${first ? `Hi ${first}.` : "Hi."} This is your first ${scenario?.title ?? "run"}.`);
  const crowdTop = crowd.find((c) => !personal.length || c.stepId !== personal[0].id);
  if (crowdTop) sentences.push(`Most people slow down at ${title(crowdTop.stepId)}, so take it steady there.`);
  if (steps[0] && !profile?.runs) sentences.push(`Start with: ${steps[0].title.toLowerCase()}.`);
  const personalized = Boolean(profile?.runs || crowdTop || session.length);
  return { scenarioId: input.scenarioId, version: scenario?.version ?? null, operatorId: input.operatorId, briefing: sentences.join(" ").slice(0, 400), hints, focusSteps: focus, source: personalized ? "rules" : "default" };
}

const coachSchema = z.object({
  briefing: z.string().min(1).max(420),
  hints: z.record(z.string(), z.string().min(1).max(220)).default({}),
  focusSteps: z.array(z.string()).max(5).default([]),
});

async function llmCoach(input: Inputs, fallback: ReturnType<typeof rulesCoach>) {
  const { scenario } = input;
  const steps = (scenario?.steps ?? []).map((step) => ({ id: step.id, kind: step.kind, title: step.title, instruction: step.instruction.slice(0, 200), tool: step.tool, hints: step.hints?.slice(0, 2), warnings: step.warnings?.slice(0, 2) }));
  const result = await completeJson("forge-coach", coachSchema, [
    { role: "system", content: "You are the Coach for SpatialForge, a mechanical and mechatronic assembly trainer. Before (or during) a run you brief one technician. The briefing is spoken aloud by a voice: at most three short sentences, plain words, no lists, no markdown, no step ids, address them by first name if given. Base it on their own past mistakes first, then on what the group struggles with. Give advice only; never change the order, tolerances or what counts as correct. Hints are one short imperative sentence per focus step. Reply with one JSON object only." },
    { role: "user", content: `Scenario: ${JSON.stringify({ title: scenario?.title, version: scenario?.version, steps })}\nOperator: ${JSON.stringify({ name: input.name, runsCompleted: input.profile?.runs ?? 0, mistakesByStepAndReason: input.profile?.mistakes ?? {}, avgStepMs: input.profile?.avgStepMs ?? {}, lastRun: input.profile?.lastRun ? { mistakes: input.profile.lastRun.mistakes, mistakeCount: input.profile.lastRun.mistakeCount } : null })}\nCurrent session (short-term): ${JSON.stringify(input.shortTerm ? { currentStepId: input.shortTerm.currentStepId, hesitating: input.shortTerm.hesitating, timeOnStepMs: input.shortTerm.timeOnStepMs, mistakes: input.shortTerm.mistakes, completed: input.shortTerm.completed } : null)}\nGroup struggle stats (share of sessions with a mistake): ${JSON.stringify(input.group.filter((s) => s.attempts).map((s) => ({ stepId: s.stepId, mistakeRate: s.mistakeRate, byReason: s.byReason, medianMs: s.medianMs })))}\nRule-based draft to improve on: ${JSON.stringify({ briefing: fallback.briefing, hints: fallback.hints, focusSteps: fallback.focusSteps })}\n\nReply {"briefing": "...", "hints": {"<stepId>": "..."}, "focusSteps": ["<stepId>", ...]} using only step ids from the scenario, at most 3 focus steps.` },
  ], { maxTokens: 1500, timeoutMs: 25000 });
  if (!result.ok) return { error: result.error };
  const valid = new Set((scenario?.steps ?? []).map((step) => step.id));
  const ok = (id: string) => !scenario || valid.has(id);
  const focusSteps = result.data.focusSteps.filter(ok).slice(0, 3);
  const hints = Object.fromEntries(Object.entries(result.data.hints).filter(([id]) => ok(id)).slice(0, 5));
  return { data: { briefing: result.data.briefing.replace(/\s+/g, " ").trim(), hints, focusSteps: focusSteps.length ? focusSteps : fallback.focusSteps }, model: result.model };
}

export async function forgeCoach(scenarioId: string, operatorId: string, options: { fresh?: boolean; noLlm?: boolean } = {}): Promise<ForgeCoach> {
  const scenario = await loadForgeScenario(scenarioId);
  const [profile, shortTerm, operator, analytics] = await Promise.all([
    operatorId ? getProfile(operatorId, scenarioId).catch((error) => { console.error("coach-forge: profile read failed", errorMessage(error)); return null; }) : null,
    operatorId ? getShortTerm(operatorId, scenarioId).catch(() => null) : null,
    operatorId ? findOperatorById(operatorId).catch(() => null) : null,
    forgeAnalytics(scenarioId, { scenario }).catch((error) => { console.error("coach-forge: analytics failed", errorMessage(error)); return null; }),
  ]);
  const input: Inputs = { scenario, scenarioId, operatorId, name: operator?.name ?? null, profile, shortTerm, group: analytics?.steps ?? [] };
  const basedOn = { runs: profile?.runs ?? 0, personalMistakes: profile?.totalMistakes ?? 0, groupStruggles: (analytics?.steps ?? []).filter((s) => s.mistakeRate >= 0.3).length, sessionMistakes: shortTerm && !shortTerm.completed ? shortTerm.mistakeCount : 0 };
  // Mid-session mistakes change the advice, so they are part of the cache key; a fresh run reuses the pre-run briefing.
  const key = `${coachKey(scenarioId, scenario?.version ?? null, operatorId, basedOn.runs)}:${basedOn.sessionMistakes}${options.noLlm ? ":rules" : ""}`;
  if (!options.fresh) {
    const hit = await kvGet(key);
    if (hit) { try { return { ...JSON.parse(hit) as ForgeCoach, cached: true }; } catch { /* recompute */ } }
  }
  const fallback = rulesCoach(input);
  let coach: ForgeCoach = { ...fallback, cached: false, basedOn };
  let fromLlm = false;
  const worthAsking = fallback.source !== "default" || Boolean(scenario);
  if (!options.noLlm && worthAsking && llmConfigured() && await allowLlmCall(valkey(), "forge-coach", 30)) {
    const llm = await llmCoach(input, fallback);
    if ("data" in llm && llm.data) { coach = { ...coach, ...llm.data, source: "llm", model: llm.model }; fromLlm = true; }
  }
  const ttl = fromLlm || !llmConfigured() || options.noLlm ? CACHE_SECONDS : FALLBACK_CACHE_SECONDS;
  await kvSet(key, JSON.stringify(coach), ttl);
  return coach;
}
