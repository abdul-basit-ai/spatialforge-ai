import type { ForgeScenario, ForgeStep, MistakeReason, Quat, Transform, Vec3 } from "./types";

// Deterministic assembly engine. Pure functions over (scenario, run state); no rendering, no I/O.
// Every mode (3D workbench, AR training, AR assist) goes through these functions, so correctness never depends on the AI.

export type RunState = {
  completed: string[]; // step ids
  installed: string[]; // part ids in their assembled pose (includes baseParts)
  activeStepId: string | null;
  startedAt: number;
  stepStartedAt: number;
  mistakes: Array<{ stepId: string | null; partId?: string; reason: MistakeReason; at: number }>;
};

export type Verdict = { ok: true; stepId: string; done: boolean } | { ok: false; reason: MistakeReason; message: string; expectedPartId?: string; stepId?: string };

// Evidence for non-placement steps (fasten/adjust/inspect/tool/connect/route).
export type StepEvidence = { tool?: string; value?: number; confirmed?: boolean; checklist?: boolean[] };

export function createRun(scenario: ForgeScenario, now = Date.now()): RunState {
  const run: RunState = { completed: [], installed: [...scenario.baseParts], activeStepId: null, startedAt: now, stepStartedAt: now, mistakes: [] };
  run.activeStepId = nextSteps(scenario, run)[0]?.id ?? null;
  return run;
}

export const stepById = (scenario: ForgeScenario, id: string | null) => scenario.steps.find((step) => step.id === id) ?? null;
export const partById = (scenario: ForgeScenario, id: string | null) => scenario.parts.find((part) => part.id === id) ?? null;

// Steps whose requirements are complete and that are not done yet, in scenario order.
export function nextSteps(scenario: ForgeScenario, run: RunState): ForgeStep[] {
  const done = new Set(run.completed);
  return scenario.steps.filter((step) => !done.has(step.id) && step.requires.every((id) => done.has(id)));
}

export const isComplete = (scenario: ForgeScenario, run: RunState) => run.completed.length >= scenario.steps.length;

// Exploded staging pose for a part not yet installed: assembled pose pulled back along its insertion axis.
export function stagingPose(scenario: ForgeScenario, partId: string, distance = 0.25): Transform {
  const part = partById(scenario, partId);
  if (!part) return { position: [0, 0, 0], quaternion: [0, 0, 0, 1] };
  const axis = part.mate.axis ?? [0, -1, 0];
  const p = part.assembled.position;
  return { position: [p[0] - axis[0] * distance, p[1] - axis[1] * distance, p[2] - axis[2] * distance], quaternion: part.assembled.quaternion };
}

// Attempt to seat `partId` at `pose` (assembly frame). Checks: right part for an available step, order, position, orientation.
export function attemptPlace(scenario: ForgeScenario, run: RunState, partId: string, pose: Transform, now = Date.now()): { verdict: Verdict; run: RunState } {
  const part = partById(scenario, partId);
  const available = nextSteps(scenario, run);
  const placing = available.find((step) => ["place", "connect", "route"].includes(step.kind) && step.partIds.includes(partId) && !step.partIds.every((id) => run.installed.includes(id)));
  if (!part) return fail(run, { reason: "wrong-part", message: "That part is not in this assembly." }, null, partId, now);
  if (!placing) {
    const later = scenario.steps.find((step) => step.partIds.includes(partId) && !run.completed.includes(step.id));
    const expected = available.find((step) => step.partIds.length)?.partIds.find((id) => !run.installed.includes(id));
    const expectedName = partById(scenario, expected ?? null)?.name;
    if (later) return fail(run, { reason: "out-of-order", message: `${part.name} goes in later.${expectedName ? ` Fit the ${expectedName} first.` : ""}`, expectedPartId: expected, stepId: later.id }, later.id, partId, now);
    return fail(run, { reason: "wrong-part", message: `${part.name} is already installed.` }, null, partId, now);
  }
  const distance = dist(pose.position, part.assembled.position);
  if (distance > part.mate.positionTolerance) return fail(run, { reason: "position", message: `Move the ${part.name} closer to its seat.`, stepId: placing.id }, placing.id, partId, now);
  const angle = orientationError(pose.quaternion, part.assembled.quaternion, part.mate);
  if (angle > part.mate.angleToleranceDeg) return fail(run, { reason: "orientation", message: `Rotate the ${part.name}; it is ${Math.round(angle)} degrees off.`, stepId: placing.id }, placing.id, partId, now);
  const installed = [...run.installed, partId];
  const stepDone = placing.partIds.every((id) => installed.includes(id));
  let next: RunState = { ...run, installed };
  if (stepDone) next = finishStep(scenario, next, placing.id, now);
  return { verdict: { ok: true, stepId: placing.id, done: stepDone }, run: next };
}

// Complete a non-placement step with evidence (tool chosen, measured value, confirmation).
export function attemptStep(scenario: ForgeScenario, run: RunState, stepId: string, evidence: StepEvidence, now = Date.now()): { verdict: Verdict; run: RunState } {
  const step = stepById(scenario, stepId);
  if (!step) return fail(run, { reason: "wrong-part", message: "Unknown step." }, null, undefined, now);
  if (!nextSteps(scenario, run).some((candidate) => candidate.id === stepId)) return fail(run, { reason: "out-of-order", message: `Finish the earlier steps before: ${step.title}.`, stepId }, stepId, undefined, now);
  const missing = step.partIds.filter((id) => !run.installed.includes(id));
  if (["place", "connect", "route"].includes(step.kind) && missing.length) return fail(run, { reason: "not-confirmed", message: `Place the ${partById(scenario, missing[0])?.name ?? "part"} first.`, stepId, expectedPartId: missing[0] }, stepId, undefined, now);
  if (step.tool && evidence.tool !== undefined && normalize(evidence.tool) !== normalize(step.tool)) return fail(run, { reason: "wrong-tool", message: `Use the ${step.tool} for this step.`, stepId }, stepId, undefined, now);
  if (step.target && evidence.value !== undefined) {
    const tolerance = step.target.tolerance ?? Math.abs(step.target.value) * 0.1;
    if (Math.abs(evidence.value - step.target.value) > tolerance) return fail(run, { reason: "out-of-range", message: `${step.target.label} should be ${step.target.value} ${step.target.unit}.`, stepId }, stepId, undefined, now);
  }
  if (!evidence.confirmed && evidence.value === undefined && evidence.tool === undefined) return fail(run, { reason: "not-confirmed", message: "Confirm the step when it is done.", stepId }, stepId, undefined, now);
  return { verdict: { ok: true, stepId, done: true }, run: finishStep(scenario, run, stepId, now) };
}

function finishStep(scenario: ForgeScenario, run: RunState, stepId: string, now: number): RunState {
  const step = stepById(scenario, stepId);
  const installed = Array.from(new Set([...run.installed, ...(step && ["place", "connect", "route"].includes(step.kind) ? step.partIds : [])]));
  const next: RunState = { ...run, installed, completed: [...run.completed, stepId], stepStartedAt: now };
  next.activeStepId = nextSteps(scenario, next)[0]?.id ?? null;
  return next;
}

function fail(run: RunState, verdict: Omit<Extract<Verdict, { ok: false }>, "ok">, stepId: string | null, partId: string | undefined, now: number) {
  return { verdict: { ok: false as const, ...verdict }, run: { ...run, mistakes: [...run.mistakes, { stepId, partId, reason: verdict.reason, at: now }] } };
}

const normalize = (value: string) => value.trim().toLowerCase();
export const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

// Angle in degrees between two orientations, honouring the mate's rotational symmetry about its axis.
export function orientationError(a: Quat, b: Quat, mate: { type: string; axis?: Vec3; symmetryDeg?: number }): number {
  const dot = Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]));
  const total = (2 * Math.acos(dot) * 180) / Math.PI;
  const symmetry = mate.symmetryDeg ?? 360;
  if (!mate.axis || symmetry >= 360) return total;
  if (symmetry <= 0) return tiltError(a, b, mate.axis);
  // Remove whole multiples of the symmetry angle about the axis: compare tilt plus residual spin.
  const tilt = tiltError(a, b, mate.axis);
  const spin = Math.max(0, total - tilt);
  const residual = spin % symmetry;
  return tilt + Math.min(residual, symmetry - residual);
}

function rotate(q: Quat, v: Vec3): Vec3 {
  const [x, y, z, w] = q; const [vx, vy, vz] = v;
  const ix = w * vx + y * vz - z * vy, iy = w * vy + z * vx - x * vz, iz = w * vz + x * vy - y * vx, iw = -x * vx - y * vy - z * vz;
  return [ix * w + iw * -x + iy * -z - iz * -y, iy * w + iw * -y + iz * -x - ix * -z, iz * w + iw * -z + ix * -y - iy * -x];
}

// How far the part's axis is tilted away from the assembled axis, ignoring spin about it.
function tiltError(a: Quat, b: Quat, axis: Vec3): number {
  const inv = (q: Quat): Quat => [-q[0], -q[1], -q[2], q[3]];
  const localAxis = rotate(inv(b), axis);
  const va = rotate(a, localAxis), vb = axis;
  const dot = Math.min(1, Math.max(-1, va[0] * vb[0] + va[1] * vb[1] + va[2] * vb[2]));
  return (Math.acos(dot) * 180) / Math.PI;
}
