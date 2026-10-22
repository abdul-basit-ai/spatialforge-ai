import * as THREE from "three";
import { slugify } from "../repo";
import type { ForgePart, ForgeScenario, ForgeStep, Quat, Vec3 } from "../types";

// Deterministic post-processing: ids, tolerances, unit axes/quaternions, a linear step chain, and the structural
// fixes that keep the engine sane (each part installed once, non-install steps only act on installed parts).

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
export const POS_TOL: [number, number] = [0.004, 0.02];
export const ANG_TOL: [number, number] = [8, 20];
const INSTALL = new Set(["place", "connect", "route"]);

export function unitAxis(axis: Vec3 | undefined): Vec3 | undefined {
  if (!axis) return undefined;
  const length = Math.hypot(...axis);
  if (!Number.isFinite(length) || length < 1e-6) return [0, -1, 0];
  return axis.map((v) => Math.round((v / length) * 1e6) / 1e6) as Vec3;
}

export function unitQuat(q: Quat | undefined): Quat {
  if (!q || !q.every(Number.isFinite)) return [0, 0, 0, 1];
  const length = Math.hypot(...q);
  return length < 1e-9 ? [0, 0, 0, 1] : (q.map((v) => v / length) as Quat);
}

export function eulerToQuat(deg: Vec3): Quat {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(...(deg.map((d) => THREE.MathUtils.degToRad(d)) as Vec3), "XYZ"));
  return [q.x, q.y, q.z, q.w];
}

const uniqueSlug = (raw: string, used: Set<string>, fallback: string) => {
  const base = slugify(raw || fallback) || fallback;
  let id = base, n = 2;
  while (used.has(id)) id = `${base}-${n++}`;
  used.add(id);
  return id;
};

export function normalizeScenario(scenario: ForgeScenario): ForgeScenario {
  // Part ids
  const partUsed = new Set<string>(), partMap = new Map<string, string>();
  const parts: ForgePart[] = scenario.parts.map((part, i) => {
    const id = uniqueSlug(part.id, partUsed, `part-${i + 1}`);
    if (!partMap.has(part.id)) partMap.set(part.id, id);
    partMap.set(id, id);
    const position = part.assembled.position.map((v) => (Number.isFinite(v) ? Math.round(v * 1e6) / 1e6 : 0)) as Vec3;
    const mate = {
      ...part.mate,
      positionTolerance: clamp(Number.isFinite(part.mate.positionTolerance) ? part.mate.positionTolerance : 0.008, ...POS_TOL),
      angleToleranceDeg: clamp(Number.isFinite(part.mate.angleToleranceDeg) ? part.mate.angleToleranceDeg : 12, ...ANG_TOL),
      axis: unitAxis(part.mate.axis) ?? [0, -1, 0] as Vec3,
      ...(part.mate.symmetryDeg !== undefined ? { symmetryDeg: clamp(part.mate.symmetryDeg, 0, 360) } : {}),
    };
    return { ...part, id, name: part.name?.trim() || `Part ${i + 1}`, assembled: { position, quaternion: unitQuat(part.assembled.quaternion) }, mate };
  });
  const mapPart = (id: string) => partMap.get(id) ?? partMap.get(slugify(id));
  const partIds = new Set(parts.map((part) => part.id));
  const baseParts = Array.from(new Set(scenario.baseParts.map(mapPart).filter((id): id is string => Boolean(id))));
  const base = new Set(baseParts);

  // Steps: ids, references, linear chain, single installation per part.
  const stepUsed = new Set<string>();
  const installed = new Set(baseParts);
  const steps: ForgeStep[] = [];
  for (const [i, raw] of scenario.steps.entries()) {
    const step: ForgeStep = { ...raw, id: uniqueSlug(raw.id, stepUsed, `step-${i + 1}`) };
    step.partIds = Array.from(new Set(raw.partIds.map(mapPart).filter((id): id is string => Boolean(id) && partIds.has(id!))));
    if (INSTALL.has(step.kind)) {
      step.partIds = step.partIds.filter((id) => !base.has(id) && !installed.has(id));
      if (!step.partIds.length) step.kind = step.torqueNm || step.tool ? "fasten" : "inspect";
      else step.partIds.forEach((id) => installed.add(id));
    }
    if (!INSTALL.has(step.kind)) step.partIds = step.partIds.filter((id) => installed.has(id));
    if (step.kind === "fasten" && !step.partIds.length && !step.tool) step.kind = "inspect";
    step.title = step.title?.trim() || `Step ${i + 1}`;
    step.instruction = step.instruction?.trim() || step.title;
    step.voiceLine = (step.voiceLine?.trim() || step.instruction).slice(0, 300);
    if (step.torqueNm !== undefined && !(step.torqueNm > 0 && step.torqueNm < 2000)) delete step.torqueNm;
    if (step.target && !Number.isFinite(step.target.value)) delete step.target;
    if (step.kind !== "adjust" && step.target && !step.target.label) delete step.target;
    for (const key of ["checklist", "warnings", "hints", "commonMistakes"] as const) { const list = step[key]?.map((s) => s.trim()).filter(Boolean); if (list?.length) step[key] = list.slice(0, 8); else delete step[key]; }
    for (const key of ["tool", "pattern"] as const) if (!step[key]?.trim()) delete step[key];
    step.requires = steps.length ? [steps[steps.length - 1].id] : [];
    steps.push(step);
  }
  // Parts nobody installs get a placement step (before a trailing inspection) so the scenario stays playable.
  const orphans: ForgeStep[] = [];
  for (const part of parts) {
    if (base.has(part.id) || installed.has(part.id)) continue;
    const id = uniqueSlug(`place-${part.id}`, stepUsed, "place");
    orphans.push({ id, kind: "place", title: `Install the ${part.name}`, instruction: `Fit the ${part.name} into its seat.`, voiceLine: `Fit the ${part.name}.`, partIds: [part.id], requires: [] });
    installed.add(part.id);
  }
  if (orphans.length) {
    steps.splice(steps.at(-1)?.kind === "inspect" ? steps.length - 1 : steps.length, 0, ...orphans);
    steps.forEach((step, i) => { step.requires = i ? [steps[i - 1].id] : []; });
  }
  return { ...scenario, parts, baseParts, steps };
}
