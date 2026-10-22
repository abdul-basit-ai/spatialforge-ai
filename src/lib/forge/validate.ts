import type { ForgeScenario } from "./types";

// Deterministic checks a scenario must pass before it can be published. Returns human-readable issues (empty = valid).
export function validateScenario(scenario: ForgeScenario): string[] {
  const issues: string[] = [];
  const partIds = new Set<string>();
  for (const part of scenario.parts) {
    if (partIds.has(part.id)) issues.push(`Duplicate part id ${part.id}.`);
    partIds.add(part.id);
    const finite = [...part.assembled.position, ...part.assembled.quaternion].every(Number.isFinite);
    if (!finite) issues.push(`${part.name}: assembled pose has invalid numbers.`);
    if (!(part.mate.positionTolerance > 0)) issues.push(`${part.name}: position tolerance must be positive.`);
    if (!(part.mate.angleToleranceDeg > 0)) issues.push(`${part.name}: angle tolerance must be positive.`);
    if (part.mate.axis && Math.abs(Math.hypot(...part.mate.axis) - 1) > 0.05) issues.push(`${part.name}: mate axis must be a unit vector.`);
  }
  for (const id of scenario.baseParts) if (!partIds.has(id)) issues.push(`Base part ${id} does not exist.`);
  const stepIds = new Set<string>();
  for (const step of scenario.steps) {
    if (stepIds.has(step.id)) issues.push(`Duplicate step id ${step.id}.`);
    stepIds.add(step.id);
  }
  const installedBy = new Map<string, string>();
  for (const step of scenario.steps) {
    for (const id of step.partIds) if (!partIds.has(id)) issues.push(`Step "${step.title}" references unknown part ${id}.`);
    for (const id of step.requires) if (!stepIds.has(id)) issues.push(`Step "${step.title}" requires unknown step ${id}.`);
    if (["place", "connect", "route"].includes(step.kind)) {
      if (!step.partIds.length) issues.push(`Step "${step.title}" installs no part.`);
      for (const id of step.partIds) {
        if (installedBy.has(id)) issues.push(`Part ${id} is installed by two steps.`);
        installedBy.set(id, step.id);
      }
    }
    if (!step.voiceLine.trim()) issues.push(`Step "${step.title}" has no voice line.`);
  }
  for (const part of scenario.parts) if (!scenario.baseParts.includes(part.id) && !installedBy.has(part.id)) issues.push(`${part.name} is never installed.`);
  // Steps must only require steps that are installable before them (no cycles).
  const visiting = new Set<string>(), done = new Set<string>();
  const byId = new Map(scenario.steps.map((step) => [step.id, step]));
  const visit = (id: string): boolean => {
    if (done.has(id)) return true;
    if (visiting.has(id)) return false;
    visiting.add(id);
    const ok = (byId.get(id)?.requires ?? []).every(visit);
    visiting.delete(id); done.add(id);
    return ok;
  };
  if (!scenario.steps.every((step) => visit(step.id))) issues.push("Step requirements contain a cycle.");
  if (!scenario.steps.length) issues.push("Scenario has no steps.");
  return Array.from(new Set(issues));
}
