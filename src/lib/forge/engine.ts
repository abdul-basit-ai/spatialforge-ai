import type { ForgePart, ForgeScenario, ForgeStep, MistakeReason, Quat, Transform, Vec3 } from "./types";

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

// blockerId: the installed part in the way (reason "blocked"); victimId: the pending part this placement would shut out.
export type Verdict =
  | { ok: true; stepId: string; done: boolean }
  | { ok: false; reason: MistakeReason; message: string; expectedPartId?: string; stepId?: string; blockerId?: string; victimId?: string };

// Evidence for non-placement steps (fasten/adjust/inspect/tool/connect/route).
// value = the measured reading for "adjust" steps, or the applied torque (Nm) for "fasten" steps with torqueNm.
export type StepEvidence = { tool?: string; value?: number; confirmed?: boolean; checklist?: boolean[] };

const PLACE_KINDS = ["place", "connect", "route"];
const isPlaceKind = (step: ForgeStep) => PLACE_KINDS.includes(step.kind);
export const STAGING_DISTANCE = 0.25;

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

export const isComplete = (scenario: ForgeScenario, run: RunState) => scenario.steps.every((step) => run.completed.includes(step.id));

export function progress(scenario: ForgeScenario, run: RunState): { done: number; total: number; percent: number } {
  const total = scenario.steps.length;
  const done = scenario.steps.filter((step) => run.completed.includes(step.id)).length;
  return { done, total, percent: total ? Math.round((done / total) * 100) : 0 };
}

// The step the trainee should do now and the parts it still needs (for highlighting and ghosts).
export function expectedNext(scenario: ForgeScenario, run: RunState): { step: ForgeStep | null; partIds: string[] } {
  const available = nextSteps(scenario, run);
  const step = available.find((candidate) => candidate.id === run.activeStepId) ?? available[0] ?? null;
  if (!step) return { step: null, partIds: [] };
  return { step, partIds: isPlaceKind(step) ? step.partIds.filter((id) => !run.installed.includes(id)) : [...step.partIds] };
}

const axisOf = (part: ForgePart): Vec3 => unit(part.mate.axis ?? [0, -1, 0]);

// Exploded staging pose for a part not yet installed: assembled pose pulled back along its insertion axis.
export function stagingPose(scenario: ForgeScenario, partId: string, distance = STAGING_DISTANCE): Transform {
  const part = partById(scenario, partId);
  if (!part) return { position: [0, 0, 0], quaternion: [0, 0, 0, 1] };
  const axis = axisOf(part);
  const p = part.assembled.position;
  return { position: [p[0] - axis[0] * distance, p[1] - axis[1] * distance, p[2] - axis[2] * distance], quaternion: part.assembled.quaternion };
}

// Magnetic snap preview: if the pose is within 2x the mate tolerances, return the assembled pose, else null.
export function snapPose(scenario: ForgeScenario, partId: string, pose: Transform): Transform | null {
  const part = partById(scenario, partId);
  if (!part) return null;
  if (dist(pose.position, part.assembled.position) > part.mate.positionTolerance * 2) return null;
  if (orientationError(pose.quaternion, part.assembled.quaternion, part.mate) > part.mate.angleToleranceDeg * 2) return null;
  return { position: [...part.assembled.position], quaternion: [...part.assembled.quaternion] };
}

// Attempt to seat `partId` at `pose` (assembly frame). Checks, in order: known part, available step, clear insertion path, position, orientation.
export function attemptPlace(scenario: ForgeScenario, run: RunState, partId: string, pose: Transform, now = Date.now()): { verdict: Verdict; run: RunState } {
  const part = partById(scenario, partId);
  const available = nextSteps(scenario, run);
  const expected = expectedNext(scenario, run);
  const expectedName = partById(scenario, expected.partIds[0] ?? null)?.name;
  const doNow = expected.step ? ` Right now: ${expected.step.title}${expectedName ? ` (${expectedName})` : ""}.` : "";
  if (!part) return fail(run, { reason: "wrong-part", message: `That part is not in this assembly. Set it aside.${doNow}`, expectedPartId: expected.partIds[0] }, null, partId, now);
  if (run.installed.includes(partId)) return fail(run, { reason: "wrong-part", message: `The ${part.name} is already installed.${doNow}`, expectedPartId: expected.partIds[0] }, null, partId, now);
  const placing = available.find((step) => isPlaceKind(step) && step.partIds.includes(partId));
  if (!placing) {
    const later = scenario.steps.find((step) => isPlaceKind(step) && step.partIds.includes(partId) && !run.completed.includes(step.id));
    if (!later) return fail(run, { reason: "wrong-part", message: `The ${part.name} is not fitted in any step of this procedure.${doNow}` }, null, partId, now);
    const pending = firstPending(scenario, run, later);
    const why = pending && pending.id !== later.id ? ` It needs "${pending.title}" done first.` : "";
    return fail(run, { reason: "out-of-order", message: `Not yet: the ${part.name} goes in at "${later.title}".${why}${doNow}`, expectedPartId: expected.partIds[0], stepId: later.id }, later.id, partId, now);
  }
  const blocker = insertionBlocker(scenario, run, partId);
  if (blocker) {
    return fail(run, { reason: "blocked", message: `Blocked: the ${blocker.name} is in the way. The ${part.name} ${approachWords(axisOf(part))} and cannot get past it to its seat.`, stepId: placing.id, blockerId: blocker.id }, placing.id, partId, now);
  }
  const positionIssue = positionMessage(part, pose);
  if (positionIssue) return fail(run, { reason: "position", message: positionIssue, stepId: placing.id }, placing.id, partId, now);
  const orientationIssue = orientationMessage(part, pose);
  if (orientationIssue) return fail(run, { reason: "orientation", message: orientationIssue, stepId: placing.id }, placing.id, partId, now);
  const victim = wouldShutOut(scenario, run, partId);
  if (victim) {
    return fail(run, { reason: "blocked", message: `Hold off on the ${part.name}: once it is in, the ${victim.name} can no longer get to its seat (it ${approachWords(axisOf(victim))}). Fit the ${victim.name} first.`, stepId: placing.id, victimId: victim.id, expectedPartId: victim.id }, placing.id, partId, now);
  }
  const installed = [...run.installed, partId];
  const stepDone = placing.partIds.every((id) => installed.includes(id));
  let next: RunState = { ...run, installed, activeStepId: placing.id };
  if (stepDone) next = finishStep(scenario, next, placing.id, now);
  return { verdict: { ok: true, stepId: placing.id, done: stepDone }, run: next };
}

// Complete a non-placement step with evidence (tool chosen, measured value, confirmation).
export function attemptStep(scenario: ForgeScenario, run: RunState, stepId: string, evidence: StepEvidence, now = Date.now()): { verdict: Verdict; run: RunState } {
  const step = stepById(scenario, stepId);
  if (!step) return fail(run, { reason: "wrong-part", message: "That step is not part of this procedure." }, null, undefined, now);
  if (run.completed.includes(stepId)) return fail(run, { reason: "out-of-order", message: `"${step.title}" is already done.`, stepId }, stepId, undefined, now);
  if (!nextSteps(scenario, run).some((candidate) => candidate.id === stepId)) {
    const pending = firstPending(scenario, run, step);
    return fail(run, { reason: "out-of-order", message: `Not yet: finish "${pending?.title ?? "the earlier steps"}" before "${step.title}".`, stepId }, stepId, undefined, now);
  }
  const missing = step.partIds.filter((id) => !run.installed.includes(id));
  if (isPlaceKind(step) && missing.length) {
    const name = partById(scenario, missing[0])?.name ?? "part";
    return fail(run, { reason: "not-confirmed", message: `Seat the ${name} first; this step finishes when every part is in place.`, stepId, expectedPartId: missing[0] }, stepId, undefined, now);
  }
  if (step.tool && evidence.tool !== undefined && !sameTool(evidence.tool, step.tool)) {
    return fail(run, { reason: "wrong-tool", message: `That is the ${evidence.tool.trim() || "wrong tool"}. "${step.title}" needs the ${step.tool}.`, stepId }, stepId, undefined, now);
  }
  if (step.kind === "tool" && step.tool && evidence.tool === undefined && !evidence.confirmed) {
    return fail(run, { reason: "not-confirmed", message: `Pick up the ${step.tool} from the tool board.`, stepId }, stepId, undefined, now);
  }
  if (evidence.value !== undefined && !Number.isFinite(evidence.value) && (step.target || step.torqueNm)) {
    const what = step.target ? `the ${step.target.label.toLowerCase()} in ${step.target.unit}` : "the torque in Nm";
    return fail(run, { reason: "not-confirmed", message: `That reading is not a number. Enter ${what}.`, stepId }, stepId, undefined, now);
  }
  if (step.target && evidence.value !== undefined) {
    const { label, value, unit } = step.target;
    const tolerance = step.target.tolerance ?? Math.abs(value) * 0.1;
    const diff = evidence.value - value;
    if (!Number.isFinite(evidence.value) || Math.abs(diff) > tolerance) {
      const fix = diff > 0 ? `Reduce it by ${fmt(Math.abs(diff))} ${unit}.` : `Increase it by ${fmt(Math.abs(diff))} ${unit}.`;
      return fail(run, { reason: "out-of-range", message: `${label} reads ${fmt(evidence.value)} ${unit}; it must be ${fmt(value)} ${unit} ± ${fmt(tolerance)}. ${fix}`, stepId }, stepId, undefined, now);
    }
  } else if (step.target && !evidence.confirmed) {
    return fail(run, { reason: "not-confirmed", message: `Measure the ${step.target.label.toLowerCase()} and enter the reading (target ${fmt(step.target.value)} ${step.target.unit}).`, stepId }, stepId, undefined, now);
  }
  if (!step.target && step.torqueNm && evidence.value !== undefined) {
    const tolerance = step.torqueNm * 0.1;
    if (!Number.isFinite(evidence.value) || Math.abs(evidence.value - step.torqueNm) > tolerance) {
      const fix = evidence.value > step.torqueNm ? "Over-torqued: back the fastener off and re-torque." : "Under-torqued: bring it up to spec.";
      return fail(run, { reason: "out-of-range", message: `Torque reads ${fmt(evidence.value)} Nm; spec is ${fmt(step.torqueNm)} Nm ± ${fmt(tolerance)}. ${fix}`, stepId }, stepId, undefined, now);
    }
  }
  if (step.checklist?.length && evidence.checklist) {
    const open = step.checklist.find((_, index) => !evidence.checklist?.[index]);
    if (open) return fail(run, { reason: "not-confirmed", message: `Check this before moving on: ${open}`, stepId }, stepId, undefined, now);
  }
  if (!evidence.confirmed && evidence.value === undefined && evidence.tool === undefined && !(step.checklist?.length && evidence.checklist)) {
    return fail(run, { reason: "not-confirmed", message: `Confirm "${step.title}" when it is done.`, stepId }, stepId, undefined, now);
  }
  return { verdict: { ok: true, stepId, done: true }, run: finishStep(scenario, run, stepId, now) };
}

function finishStep(scenario: ForgeScenario, run: RunState, stepId: string, now: number): RunState {
  const step = stepById(scenario, stepId);
  const installed = Array.from(new Set([...run.installed, ...(step && isPlaceKind(step) ? step.partIds : [])]));
  const next: RunState = { ...run, installed, completed: [...run.completed, stepId], stepStartedAt: now };
  next.activeStepId = nextSteps(scenario, next)[0]?.id ?? null;
  return next;
}

function fail(run: RunState, verdict: Omit<Extract<Verdict, { ok: false }>, "ok">, stepId: string | null, partId: string | undefined, now: number) {
  return { verdict: { ok: false as const, ...verdict }, run: { ...run, mistakes: [...run.mistakes, { stepId, partId, reason: verdict.reason, at: now }] } };
}

// Earliest incomplete step in the requirement chain of `step` that can be done now.
function firstPending(scenario: ForgeScenario, run: RunState, step: ForgeStep): ForgeStep | null {
  const done = new Set(run.completed), seen = new Set<string>();
  const walk = (current: ForgeStep): ForgeStep | null => {
    if (seen.has(current.id)) return null;
    seen.add(current.id);
    for (const id of current.requires) {
      const required = stepById(scenario, id);
      if (required && !done.has(id)) return walk(required) ?? required;
    }
    return null;
  };
  return walk(step) ?? step;
}

const normalize = (value: string) => value.trim().toLowerCase().replace(/allen/g, "hex").replace(/[^a-z0-9.]/g, "");
const sameTool = (a: string, b: string) => normalize(a) === normalize(b);
const fmt = (value: number) => (Math.abs(value) >= 10 ? String(Math.round(value * 10) / 10) : String(Math.round(value * 100) / 100));
const mm = (metres: number) => `${fmt(metres * 1000)} mm`;

// ---------- Position and orientation, by mate type ----------

const DIRS: Array<[Vec3, string]> = [[[1, 0, 0], "to the right"], [[-1, 0, 0], "to the left"], [[0, 1, 0], "up"], [[0, -1, 0], "down"], [[0, 0, 1], "toward you"], [[0, 0, -1], "away from you"]];
const directionWords = (v: Vec3) => DIRS.reduce((best, entry) => (dot(entry[0], v) > dot(best[0], v) ? entry : best), DIRS[0])[1];

// How the part travels into its seat, e.g. "drops in from above".
export function approachWords(axis: Vec3): string {
  const from = directionWords([-axis[0], -axis[1], -axis[2]]);
  if (from === "up") return "drops in from above";
  if (from === "down") return "goes in from below";
  return `slides in from ${from === "toward you" ? "the front" : from === "away from you" ? "the back" : from.replace("to the ", "the ")}`;
}

// Null when the pose is within tolerance; otherwise a technician-friendly correction.
function positionMessage(part: ForgePart, pose: Transform): string | null {
  const tol = part.mate.positionTolerance;
  const delta = sub(pose.position, part.assembled.position);
  const toSeat: Vec3 = [-delta[0], -delta[1], -delta[2]];
  if (part.mate.type === "fixed" || !part.mate.axis) {
    const d = len(delta);
    return d > tol ? `Move the ${part.name} ${mm(d)} ${directionWords(toSeat)} to reach its seat.` : null;
  }
  const axis = axisOf(part);
  const along = dot(delta, axis);
  const off = sub(delta, scale(axis, along));
  const offDist = len(off);
  if (part.mate.type === "axial") {
    if (offDist > tol) return `The ${part.name} is ${mm(offDist)} off its centreline. Line it up by moving it ${directionWords(scale(off, -1))}, then slide it in.`;
    if (along < -tol) return `The ${part.name} is lined up but not fully seated. Push it ${mm(-along)} further in.`;
    if (along > tol) return `The ${part.name} has gone ${mm(along)} past its seat. Back it off.`;
    return null;
  }
  if (Math.abs(along) > tol) return along < 0 ? `The ${part.name} is not sitting flat on its face: lower it ${mm(-along)} until it is flush.` : `The ${part.name} is pressed ${mm(along)} into the mating face. Lift it until it sits flush.`;
  if (offDist > tol) return `The ${part.name} is flush but ${mm(offDist)} off position. Slide it ${directionWords(scale(off, -1))} until the holes line up.`;
  return null;
}

function orientationMessage(part: ForgePart, pose: Transform): string | null {
  const { tilt, spin, total } = orientationParts(pose.quaternion, part.assembled.quaternion, part.mate);
  if (total <= part.mate.angleToleranceDeg) return null;
  const keyed = (part.mate.symmetryDeg ?? 360) >= 360;
  if (part.mate.axis && tilt > part.mate.angleToleranceDeg && tilt >= spin) {
    return part.mate.type === "planar" ? `The ${part.name} is tipped ${Math.round(tilt)}° off its mating face. Lay it flat.` : `The ${part.name} is tilted ${Math.round(tilt)}° off its axis. Square it up with the bore before you push it in.`;
  }
  if (part.mate.axis) {
    const keyNote = keyed ? " It is keyed and only fits one way: match the key, flat or marking." : ` It repeats every ${part.mate.symmetryDeg}°, so the nearest matching position is ${Math.round(spin)}° away.`;
    return `Turn the ${part.name} ${Math.round(spin)}° about its axis.${keyNote}`;
  }
  return `Rotate the ${part.name}; it is ${Math.round(total)}° off its fitted orientation.`;
}

// Angle in degrees between two orientations, honouring the mate's rotational symmetry about its axis.
// symmetryDeg 360 (default) = keyed, 90 = square, 0 = any spin about the axis.
export function orientationError(a: Quat, b: Quat, mate: { type: string; axis?: Vec3; symmetryDeg?: number }): number {
  return orientationParts(a, b, mate).total;
}

// Swing-twist split of the orientation error: tilt of the axis, residual spin about it (after symmetry), and the combined angle.
export function orientationParts(a: Quat, b: Quat, mate: { type: string; axis?: Vec3; symmetryDeg?: number }): { tilt: number; spin: number; total: number } {
  const r = qmul(qnorm(a), qconj(qnorm(b))); // world-frame rotation from seated to attempted
  if (!mate.axis) { const total = qangle(r); return { tilt: total, spin: 0, total }; }
  const n = unit(mate.axis);
  const p = r[0] * n[0] + r[1] * n[1] + r[2] * n[2];
  const twistRaw: Quat = [n[0] * p, n[1] * p, n[2] * p, r[3]];
  const twistLen = Math.hypot(...twistRaw);
  const twist: Quat = twistLen < 1e-9 ? [0, 0, 0, 1] : (twistRaw.map((v) => v / twistLen) as Quat);
  const swing = qmul(r, qconj(twist));
  const spinDeg = ((2 * Math.atan2(twist[0] * n[0] + twist[1] * n[1] + twist[2] * n[2], twist[3]) * 180) / Math.PI + 720) % 360;
  const symmetry = mate.symmetryDeg ?? 360;
  const period = symmetry <= 0 ? 0 : Math.min(360, symmetry);
  let residual = 0;
  if (period > 0) { const m = spinDeg % period; residual = m <= period / 2 ? m : m - period; }
  const half = (residual * Math.PI) / 360;
  const residualTwist: Quat = [n[0] * Math.sin(half), n[1] * Math.sin(half), n[2] * Math.sin(half), Math.cos(half)];
  return { tilt: qangle(swing), spin: Math.abs(residual), total: qangle(qmul(swing, residualTwist)) };
}

// ---------- Insertion path (blocked) checks ----------

type Box = { min: Vec3; max: Vec3 };
const OVERLAP_SLACK = 0.0015; // metres of interpenetration allowed, so touching faces never count as collisions

// Local bounding-box size of a part: explicit bounds, else derived from primitive params (mirrors three-parts.ts), else null (unknown mesh).
export function partSize(part: ForgePart): Vec3 | null {
  if (part.bounds?.size?.every((v) => Number.isFinite(v) && v > 0)) return part.bounds.size;
  if (part.geometry.kind !== "primitive") return null;
  const { shape, params: p } = part.geometry;
  const r = p.radius ?? 0.02, length = p.length ?? p.height ?? 0.05;
  switch (shape) {
    case "cylinder": case "shaft": case "leadscrew": case "cap": case "motor": case "tube": case "bearing": case "coupling": case "pulley": case "hex": case "nut": return [2 * r, length, 2 * r];
    case "bolt": case "screw": { const b = p.radius ?? 0.003; return [2 * b, length, 2 * b]; }
    case "gear": return [2 * r, p.thickness ?? 0.01, 2 * r];
    case "torus": case "washer": { const t = p.tube ?? r * 0.25; return [2 * (r + t), 2 * (r + t), 2 * t]; }
    case "spring": { const t = r * 0.12; return [3 * r + 2 * t, 3 * r + 2 * t, r + 2 * t]; }
    default: return [p.width ?? 0.05, p.height ?? 0.05, p.depth ?? 0.05];
  }
}

// World-space axis-aligned box of a part at a pose.
export function worldBox(part: ForgePart, pose: Transform): Box | null {
  const size = partSize(part);
  if (!size) return null;
  const [x, y, z, w] = qnorm(pose.quaternion);
  const m = [
    [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
    [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
    [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
  ];
  const half = size.map((v) => v / 2);
  const extent = m.map((row) => Math.abs(row[0]) * half[0] + Math.abs(row[1]) * half[1] + Math.abs(row[2]) * half[2]) as Vec3;
  const c = pose.position;
  return { min: [c[0] - extent[0], c[1] - extent[1], c[2] - extent[2]], max: [c[0] + extent[0], c[1] + extent[1], c[2] + extent[2]] };
}

const overlaps = (a: Box, b: Box) => [0, 1, 2].every((i) => a.min[i] < b.max[i] - OVERLAP_SLACK && b.min[i] < a.max[i] - OVERLAP_SLACK);
const union = (a: Box, b: Box): Box => ({ min: a.min.map((v, i) => Math.min(v, b.min[i])) as Vec3, max: a.max.map((v, i) => Math.max(v, b.max[i])) as Vec3 });

// Does `obstacle` (in its assembled pose) sit on the path of `mover` from staging to seat?
// Obstacles that overlap the mover's seat are its mating hosts (the bore it goes into, the rail it rides on) and never block it.
function blocksPath(scenario: ForgeScenario, mover: ForgePart, obstacle: ForgePart): boolean {
  const seat = worldBox(mover, mover.assembled), start = worldBox(mover, stagingPose(scenario, mover.id)), box = worldBox(obstacle, obstacle.assembled);
  if (!seat || !start || !box) return false;
  return overlaps(union(seat, start), box) && !overlaps(seat, box);
}

// The installed part (if any) that occupies `partId`'s insertion path, nearest the seat first.
export function insertionBlocker(scenario: ForgeScenario, run: RunState, partId: string): ForgePart | null {
  const mover = partById(scenario, partId);
  if (!mover) return null;
  const blockers = run.installed.filter((id) => id !== partId).map((id) => partById(scenario, id)).filter((part): part is ForgePart => Boolean(part && blocksPath(scenario, mover, part)));
  return blockers.sort((a, b) => dist(a.assembled.position, mover.assembled.position) - dist(b.assembled.position, mover.assembled.position))[0] ?? null;
}

// A part that can be fitted right now but whose path `partId` would close off. Only reported when the other order works,
// so this guidance never creates a dead end.
export function wouldShutOut(scenario: ForgeScenario, run: RunState, partId: string): ForgePart | null {
  const part = partById(scenario, partId);
  if (!part) return null;
  for (const step of nextSteps(scenario, run)) {
    if (!isPlaceKind(step)) continue;
    for (const id of step.partIds) {
      if (id === partId || run.installed.includes(id)) continue;
      const victim = partById(scenario, id);
      if (!victim || !blocksPath(scenario, victim, part) || blocksPath(scenario, part, victim) || insertionBlocker(scenario, run, id)) continue;
      return victim;
    }
  }
  return null;
}

// ---------- Vector and quaternion helpers ----------

export const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: Vec3): Vec3 => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const qnorm = (q: Quat): Quat => { const l = Math.hypot(...q) || 1; return [q[0] / l, q[1] / l, q[2] / l, q[3] / l]; };
const qconj = (q: Quat): Quat => [-q[0], -q[1], -q[2], q[3]];
const qangle = (q: Quat) => (2 * Math.acos(Math.min(1, Math.abs(q[3]))) * 180) / Math.PI;
export function qmul(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a, [bx, by, bz, bw] = b;
  return [aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz];
}
// Quaternion for a rotation of `deg` degrees about `axis`.
export function quatAxisAngle(axis: Vec3, deg: number): Quat {
  const n = unit(axis), h = (deg * Math.PI) / 360, s = Math.sin(h);
  return [n[0] * s, n[1] * s, n[2] * s, Math.cos(h)];
}
