import { slugify } from "../repo";
import type { ForgePart, ForgeScenario, ForgeStep, PartCategory, Vec3 } from "../types";
import * as THREE from "three";
import { clamp, eulerToQuat, unitAxis, unitQuat } from "./normalize";
import type { CadDraft, GeneratedDraft, StepDraft } from "./schemas";
import type { SequencePlan } from "./sequence";
import type { CadInput } from "./types";

// Builds ForgeScenarios: the deterministic CAD skeleton, the merge of the model's procedure into it, and generated drafts.

export const CATEGORY_COLORS: Record<PartCategory, string> = {
  structural: "#6b7785", fastener: "#c9ced6", seal: "#22262b", bearing: "#a7b4c2", drive: "#c99a2e", motor: "#2b3038",
  sensor: "#2fb5c9", electronics: "#1f7a4d", connector: "#e3e5e8", cable: "#30353d", tool: "#e0a030", other: "#8a96a3",
};
const INSTALL = new Set(["place", "connect", "route"]);

export function guessCategory(name: string): PartCategory {
  const n = name.toLowerCase();
  if (/screw|bolt|nut\b|washer|rivet|shcs|bhcs|fhcs|\bm\d+\s?x/.test(n)) return "fastener";
  if (/bearing|bushing/.test(n)) return "bearing";
  if (/motor|stepper|nema|servo/.test(n)) return "motor";
  if (/sensor|switch|encoder|endstop|limit/.test(n)) return "sensor";
  if (/pcb|board|driver|controller/.test(n)) return "electronics";
  if (/connector|plug|socket|header/.test(n)) return "connector";
  if (/cable|wire|harness/.test(n)) return "cable";
  if (/seal|o-?ring|gasket/.test(n)) return "seal";
  if (/gear|pulley|belt|shaft|lead ?screw|coupl|pinion|sprocket|carrier/.test(n)) return "drive";
  return "structural";
}

const direction = (axis: Vec3) => {
  const [x, y, z] = axis;
  if (y < -0.9) return "straight down from above";
  if (y > 0.9) return "up from below";
  if (Math.abs(x) > 0.9) return `sideways along ${x > 0 ? "+X (left to right)" : "-X (right to left)"}`;
  if (Math.abs(z) > 0.9) return `along ${z > 0 ? "+Z (toward you)" : "-Z (away from you)"}`;
  return "along its insertion axis";
};
const pretty = (node: string) => node.replace(/\.(step|stp|stl|igs|iges)$/i, "").replace(/[_]+/g, " ").replace(/\s+/g, " ").trim();
const plural = (word: string, n: number) => (n === 1 ? word : `${n} × ${word}`);

export type Skeleton = { scenario: ForgeScenario; partIdByNode: Map<string, string>; skeletonSteps: ForgeStep[] };

export function cadSkeleton(cad: CadInput, plan: SequencePlan, meta: { title: string; domain?: ForgeScenario["domain"]; source: ForgeScenario["source"] }): Skeleton {
  const used = new Set<string>(), partIdByNode = new Map<string, string>();
  const byNode = new Map(cad.parts.map((part) => [part.node, part]));
  const parts: ForgePart[] = cad.parts.map((cadPart, i) => {
    let id = slugify(cadPart.node) || `part-${i + 1}`, n = 2;
    while (used.has(id)) id = `${slugify(cadPart.node) || "part"}-${n++}`;
    used.add(id); partIdByNode.set(cadPart.node, id);
    const name = pretty(cadPart.name || cadPart.node);
    const category = guessCategory(`${cadPart.name} ${cadPart.node}`);
    const size = [0, 1, 2].map((k) => Math.abs(cadPart.bbox.max[k] - cadPart.bbox.min[k]));
    const round = category === "fastener" || category === "bearing" || category === "seal";
    return {
      id, name, category,
      geometry: { kind: "mesh", assetId: cad.assetId, node: cadPart.node },
      color: cadPart.color ?? CATEGORY_COLORS[category],
      assembled: { position: cadPart.position, quaternion: unitQuat(cadPart.quaternion) },
      mate: { type: round ? "axial" : "fixed", axis: plan.axes[cadPart.node] ?? [0, -1, 0], positionTolerance: clamp(0.25 * Math.min(...size.filter((s) => s > 0), 0.08), 0.004, 0.02), angleToleranceDeg: 12, symmetryDeg: round ? 0 : 360 },
    };
  });
  const nameOf = (node: string) => pretty(byNode.get(node)?.name || node);
  const steps: ForgeStep[] = [];
  const stepIds = new Set<string>();
  const addStep = (step: Omit<ForgeStep, "requires">) => {
    let id = step.id, n = 2;
    while (stepIds.has(id)) id = `${step.id}-${n++}`;
    stepIds.add(id);
    steps.push({ ...step, id, requires: steps.length ? [steps[steps.length - 1].id] : [] });
  };
  for (const item of plan.steps) {
    if (item.kind === "place") {
      const node = item.nodes[0], id = partIdByNode.get(node)!, name = nameOf(node);
      addStep({ id: `install-${id}`, kind: "place", title: `Install the ${name}`, instruction: `Bring the ${name} in ${direction(item.axis)} and seat it against its mating faces.${item.interlocked ? " Check the clearance carefully; this part is tightly nested." : ""}`, voiceLine: `Fit the ${name}.`, partIds: [id] });
    } else {
      const ids = item.nodes.map((node) => partIdByNode.get(node)!), family = pretty(item.family), holder = nameOf(item.holder);
      addStep({ id: `insert-${slugify(item.family)}-${partIdByNode.get(item.holder)}`, kind: "place", title: `Insert ${plural(family, ids.length)}`, instruction: `Insert ${plural(family, ids.length)} ${direction(item.axis)} into the ${holder}. Start each one by hand.`, voiceLine: `Start the ${family}${ids.length > 1 ? "s" : ""} by hand.`, partIds: ids });
      if (item.fastenNodes?.length) {
        const tight = item.fastenNodes.map((node) => partIdByNode.get(node)!), many = tight.length > 1;
        addStep({ id: `tighten-${partIdByNode.get(item.holder)}`, kind: "fasten", title: `Tighten the ${holder} fasteners`, instruction: `Tighten the fasteners on the ${holder}${many ? " evenly in a cross pattern" : ""} until snug.`, voiceLine: `Tighten the ${holder} fasteners${many ? " in a cross pattern" : ""}.`, partIds: tight, ...(tight.length > 2 ? { pattern: "cross pattern, two passes" } : {}) });
      }
    }
  }
  addStep({ id: "final-inspection", kind: "inspect", title: "Final inspection", instruction: "Check that every part is seated, nothing is loose and moving parts turn freely.", voiceLine: "Inspect the finished assembly.", partIds: [], checklist: ["All parts seated", "Fasteners tight", "Moving parts turn freely"] });
  const now = new Date().toISOString();
  const scenario: ForgeScenario = {
    id: slugify(meta.title), version: 1, status: "draft", title: meta.title, summary: `Assembly of ${parts.length} parts in ${steps.length} steps, sequenced from the CAD geometry.`,
    domain: meta.domain ?? (parts.some((part) => ["motor", "sensor", "electronics", "connector", "cable"].includes(part.category)) ? "mechatronic" : "mechanical"),
    source: meta.source, baseParts: [partIdByNode.get(plan.base)!], parts, steps, createdAt: now, updatedAt: now,
  };
  return { scenario, partIdByNode, skeletonSteps: steps };
}

const nonEmpty = <T>(value: T[] | undefined) => (value && value.length ? value : undefined);

// Applies the model's names and procedure text to the skeleton without changing the deterministic install order.
export function mergeCadDraft(skeleton: Skeleton, draft: CadDraft): { scenario: ForgeScenario; extras: number; dropped: number } {
  const base = skeleton.scenario;
  const partInfo = new Map(draft.parts.map((part) => [part.id, part]));
  const parts = base.parts.map((part) => {
    const info = partInfo.get(part.id);
    if (!info) return part;
    const category = info.category ?? part.category;
    const symmetry = info.symmetryDeg !== undefined && Number.isFinite(info.symmetryDeg) ? clamp(info.symmetryDeg, 0, 360) : part.mate.symmetryDeg;
    return { ...part, name: info.name?.trim() || part.name, category, description: info.description || part.description, color: part.color === CATEGORY_COLORS[part.category] ? (/^#[0-9a-f]{6}$/i.test(info.color ?? "") ? info.color! : CATEGORY_COLORS[category]) : part.color, mate: { ...part.mate, symmetryDeg: symmetry } };
  });
  const skeletonIds = new Set(skeleton.skeletonSteps.map((step) => step.id));
  const fromAi = new Map<string, StepDraft>();
  const extrasAfter = new Map<string, StepDraft[]>();
  let anchor = "__start", dropped = 0;
  for (const step of draft.steps) {
    if (skeletonIds.has(step.id)) { if (!fromAi.has(step.id)) fromAi.set(step.id, step); anchor = step.id; continue; }
    if (INSTALL.has(step.kind)) { dropped++; continue; } // the model may not invent new installs in CAD mode
    const list = extrasAfter.get(anchor) ?? [];
    list.push(step); extrasAfter.set(anchor, list);
  }
  const text = (s: StepDraft, fallback: ForgeStep): Partial<ForgeStep> => ({
    title: s.title?.trim() || fallback.title, instruction: s.instruction?.trim() || fallback.instruction, voiceLine: s.voiceLine?.trim() || fallback.voiceLine,
    tool: s.tool || fallback.tool, torqueNm: s.torqueNm ?? fallback.torqueNm, pattern: s.pattern || fallback.pattern,
    target: s.target ? { label: s.target.label, value: s.target.value, unit: s.target.unit, ...(s.target.tolerance !== undefined ? { tolerance: s.target.tolerance } : {}) } : fallback.target,
    checklist: nonEmpty(s.checklist) ?? fallback.checklist, warnings: nonEmpty(s.warnings), hints: nonEmpty(s.hints), commonMistakes: nonEmpty(s.commonMistakes),
  });
  const toExtra = (s: StepDraft): ForgeStep => ({ id: `x-${slugify(s.id || s.title)}`, kind: s.kind, partIds: s.partIds, requires: [], ...text(s, { id: "", kind: s.kind, title: s.title || "Check", instruction: s.instruction || s.title || "Check the assembly.", voiceLine: s.voiceLine || s.title || "Check the assembly.", partIds: [], requires: [] }) } as ForgeStep);
  const steps: ForgeStep[] = [];
  let extras = 0;
  for (const s of extrasAfter.get("__start") ?? []) { steps.push(toExtra(s)); extras++; }
  for (const step of skeleton.skeletonSteps) {
    const ai = fromAi.get(step.id);
    const kind = ai && INSTALL.has(step.kind) && INSTALL.has(ai.kind) ? ai.kind : step.kind;
    steps.push(ai ? { ...step, kind, ...text(ai, step) } as ForgeStep : step);
    for (const s of extrasAfter.get(step.id) ?? []) { steps.push(toExtra(s)); extras++; }
  }
  for (const step of steps) for (const key of Object.keys(step) as Array<keyof ForgeStep>) if (step[key] === undefined) delete step[key];
  return { scenario: { ...base, title: draft.title?.trim() || base.title, summary: draft.summary?.trim() || base.summary, domain: draft.domain ?? base.domain, parts, steps }, extras, dropped };
}

// Generated (no CAD) drafts: parametric primitives with assembled poses.
export function scenarioFromGenerated(draft: GeneratedDraft, meta: { domain?: ForgeScenario["domain"]; source: ForgeScenario["source"] }): ForgeScenario {
  const parts: ForgePart[] = draft.parts.map((p) => {
    const params = Object.fromEntries(Object.entries(p.params).filter(([, v]) => Number.isFinite(v)).map(([k, v]) => [k, k === "teeth" || k === "turns" ? clamp(Math.round(v), 3, 200) : clamp(Math.abs(v), 0.0005, 3)]));
    const quaternion = p.quaternion ? unitQuat(p.quaternion) : p.rotationDeg ? eulerToQuat(p.rotationDeg) : [0, 0, 0, 1] as ForgePart["assembled"]["quaternion"];
    return {
      id: p.id, name: p.name, category: p.category, description: p.description,
      geometry: { kind: "primitive", shape: p.shape, params },
      color: /^#[0-9a-f]{6}$/i.test(p.color ?? "") ? p.color : CATEGORY_COLORS[p.category],
      assembled: { position: p.position, quaternion },
      mate: { type: p.mateType, axis: unitAxis(p.axis ?? [0, -1, 0]), positionTolerance: p.positionTolerance ?? 0.008, angleToleranceDeg: p.angleToleranceDeg ?? 12, ...(p.symmetryDeg !== undefined ? { symmetryDeg: p.symmetryDeg } : {}) },
    } as ForgePart;
  });
  let baseParts = draft.baseParts;
  if (!baseParts.length) {
    const placed = new Set(draft.steps.filter((s) => INSTALL.has(s.kind)).flatMap((s) => s.partIds));
    baseParts = parts.filter((part) => !placed.has(part.id) && part.category === "structural").map((part) => part.id).slice(0, 1);
  }
  const steps: ForgeStep[] = draft.steps.map((s) => {
    const step: ForgeStep = { id: s.id, kind: s.kind, title: s.title, instruction: s.instruction, voiceLine: s.voiceLine, partIds: s.partIds, requires: [] };
    if (s.tool) step.tool = s.tool;
    if (s.torqueNm !== undefined) step.torqueNm = s.torqueNm;
    if (s.pattern) step.pattern = s.pattern;
    if (s.target) step.target = { label: s.target.label, value: s.target.value, unit: s.target.unit, ...(s.target.tolerance !== undefined ? { tolerance: s.target.tolerance } : {}) };
    for (const key of ["checklist", "warnings", "hints", "commonMistakes"] as const) if (s[key].length) step[key] = s[key];
    return step;
  });
  const now = new Date().toISOString();
  return { id: slugify(draft.title), version: 1, status: "draft", title: draft.title, summary: draft.summary, domain: meta.domain ?? draft.domain, source: meta.source, baseParts, parts, steps, createdAt: now, updatedAt: now };
}

const quatToEuler = (q: ForgePart["assembled"]["quaternion"]): Vec3 => {
  const e = new THREE.Euler().setFromQuaternion(new THREE.Quaternion(...q), "XYZ");
  return [e.x, e.y, e.z].map((r) => Math.round(THREE.MathUtils.radToDeg(r) * 100) / 100) as Vec3;
};

// Back to the draft shape (for the repair pass).
export function toGeneratedDraft(scenario: ForgeScenario, assumptions: string[]): GeneratedDraft {
  return {
    title: scenario.title, summary: scenario.summary, domain: scenario.domain, assumptions, baseParts: scenario.baseParts,
    parts: scenario.parts.map((part) => ({
      id: part.id, name: part.name, category: part.category, shape: part.geometry.kind === "primitive" ? part.geometry.shape : "box", params: part.geometry.kind === "primitive" ? part.geometry.params : {},
      color: part.color, position: part.assembled.position, quaternion: undefined, rotationDeg: quatToEuler(part.assembled.quaternion), mateType: part.mate.type, axis: part.mate.axis,
      symmetryDeg: part.mate.symmetryDeg, positionTolerance: part.mate.positionTolerance, angleToleranceDeg: part.mate.angleToleranceDeg, description: part.description,
    })),
    steps: scenario.steps.map((step) => ({ id: step.id, kind: step.kind, title: step.title, instruction: step.instruction, voiceLine: step.voiceLine, partIds: step.partIds, tool: step.tool, torqueNm: step.torqueNm, pattern: step.pattern, target: step.target ? { ...step.target, tolerance: step.target.tolerance } : undefined, checklist: step.checklist ?? [], warnings: step.warnings ?? [], hints: step.hints ?? [], commonMistakes: step.commonMistakes ?? [] })),
  };
}
