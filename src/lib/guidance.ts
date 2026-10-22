import { getScenario, type PartDefinition, type PartId, type ScenarioId } from "@/lib/assembly";
import { DEFAULT_DAG_VERSION } from "@/lib/spatial-engine";

// Versioned instruction text. Only these fields can be changed by agents or admins; targets, rotations,
// and prerequisites stay deterministic in assembly.ts.
export const GUIDANCE_FIELDS = ["preWarning", "hint", "voiceLine", "substeps"] as const;
export type StepGuidance = { preWarning?: string; hint?: string; voiceLine?: string; substeps?: string[] };
export type Guidance = { steps: Partial<Record<PartId, StepGuidance>> };
export type CoachBriefing = { scenario: ScenarioId; operator: string; version: string; briefing: string; steps: Guidance["steps"]; source: "llm" | "rules" | "default"; cached: boolean; persisted: boolean };

export const emptyGuidance = (): Guidance => ({ steps: {} });

// Keeps only known steps and allowed fields, so stored or proposed JSON can never carry anything else.
export function cleanGuidance(scenario: ScenarioId, value: unknown): Guidance {
  const steps = value && typeof value === "object" && (value as Guidance).steps && typeof (value as Guidance).steps === "object" ? (value as Guidance).steps as Record<string, unknown> : {};
  const out: Guidance = { steps: {} };
  for (const part of getScenario(scenario).parts) {
    const raw = steps[part.id] as Record<string, unknown> | undefined;
    if (!raw || typeof raw !== "object") continue;
    const step: StepGuidance = {};
    for (const field of ["preWarning", "hint", "voiceLine"] as const) if (typeof raw[field] === "string" && raw[field]) step[field] = (raw[field] as string).slice(0, 240);
    if (Array.isArray(raw.substeps)) { const substeps = raw.substeps.filter((item): item is string => typeof item === "string" && Boolean(item)).slice(0, 5).map((item) => item.slice(0, 140)); if (substeps.length) step.substeps = substeps; }
    if (Object.keys(step).length) out.steps[part.id] = step;
  }
  return out;
}

export function mergeGuidance(base: Guidance, patch: Guidance): Guidance {
  const steps: Guidance["steps"] = { ...base.steps };
  for (const [id, step] of Object.entries(patch.steps) as Array<[PartId, StepGuidance]>) steps[id] = { ...steps[id], ...step };
  return { steps };
}

// 1.0 -> 1.1 -> ... -> 1.10; unparseable versions restart at <major>.1.
export function nextVersion(versions: string[]): string {
  const parsed = versions.map((version) => version.split(".").map(Number)).filter((parts) => parts.length === 2 && parts.every(Number.isInteger));
  if (!parsed.length) return "1.1";
  parsed.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const [major, minor] = parsed[parsed.length - 1];
  return `${major}.${minor + 1}`;
}

export function defaultBriefing(scenario: ScenarioId, guidance: Guidance = emptyGuidance(), version = DEFAULT_DAG_VERSION): CoachBriefing {
  const definition = getScenario(scenario);
  const first = definition.parts[0];
  const briefing = scenario === "tray" ? `${definition.name}: place each shape in its matching target, in any order.` : `${definition.name}: begin with ${first.short}. ${guidance.steps[first.id]?.hint || first.cue}.`;
  return { scenario, operator: "", version, briefing, steps: guidance.steps, source: "default", cached: false, persisted: false };
}

export const stepCue = (steps: Guidance["steps"] | undefined, part: PartDefinition) => steps?.[part.id]?.hint || part.cue;
