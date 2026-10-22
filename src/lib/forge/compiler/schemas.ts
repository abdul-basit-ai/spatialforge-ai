import { z } from "zod";
import type { PartCategory, PrimitiveShape, StepKind } from "../types";

// Lenient zod schemas for the model's drafts: bad enum values fall back instead of failing the whole compile.

export const CATEGORIES: PartCategory[] = ["structural", "fastener", "seal", "bearing", "drive", "motor", "sensor", "electronics", "connector", "cable", "tool", "other"];
export const SHAPES: PrimitiveShape[] = ["box", "plate", "bracket", "cylinder", "shaft", "tube", "hex", "torus", "washer", "nut", "bolt", "screw", "spring", "gear", "pulley", "belt", "bearing", "coupling", "rail", "carriage", "leadscrew", "motor", "sensor", "pcb", "connector", "cable", "housing", "cap"];
export const KINDS: StepKind[] = ["place", "fasten", "connect", "route", "adjust", "inspect", "tool"];

const num = z.coerce.number();
const vec3 = z.array(num).min(3).transform((a) => [a[0], a[1], a[2]] as [number, number, number]);
const quat = z.array(num).min(4).transform((a) => [a[0], a[1], a[2], a[3]] as [number, number, number, number]);
const strings = z.array(z.coerce.string()).default([]).catch([]);
const optText = z.string().nullish().transform((v) => v ?? undefined);
const optNum = z.coerce.number().nullish().catch(undefined).transform((v) => (v === null || v === undefined || !Number.isFinite(v) ? undefined : v));

export const StepDraftSchema = z.object({
  id: z.coerce.string(),
  kind: z.enum(KINDS as [StepKind, ...StepKind[]]).catch("inspect"),
  title: z.coerce.string().default("Step"),
  instruction: z.coerce.string().default(""),
  voiceLine: z.coerce.string().default(""),
  partIds: strings,
  tool: optText,
  torqueNm: optNum,
  pattern: optText,
  target: z.object({ label: z.coerce.string(), value: num, unit: z.coerce.string(), tolerance: optNum }).nullish().catch(undefined),
  checklist: strings,
  warnings: strings,
  hints: strings,
  commonMistakes: strings,
});
export type StepDraft = z.infer<typeof StepDraftSchema>;

export const PartDraftSchema = z.object({
  id: z.coerce.string(),
  name: z.coerce.string().default("Part"),
  category: z.enum(CATEGORIES as [PartCategory, ...PartCategory[]]).catch("other"),
  shape: z.enum(SHAPES as [PrimitiveShape, ...PrimitiveShape[]]).catch("box"),
  params: z.record(z.string(), z.coerce.number()).default({}).catch({}),
  color: optText,
  position: vec3.catch([0, 0, 0]),
  rotationDeg: vec3.nullish().catch(undefined),
  quaternion: quat.nullish().catch(undefined),
  mateType: z.enum(["fixed", "axial", "planar"]).catch("fixed").default("fixed"),
  axis: vec3.nullish().catch(undefined),
  symmetryDeg: optNum,
  positionTolerance: optNum,
  angleToleranceDeg: optNum,
  description: optText,
});
export type PartDraft = z.infer<typeof PartDraftSchema>;

export const GeneratedDraftSchema = z.object({
  title: z.coerce.string().default("Assembly"),
  summary: z.coerce.string().default(""),
  domain: z.enum(["mechanical", "mechatronic"]).catch("mechanical").default("mechanical"),
  assumptions: strings,
  baseParts: strings,
  parts: z.array(PartDraftSchema).min(1),
  steps: z.array(StepDraftSchema).min(1),
});
export type GeneratedDraft = z.infer<typeof GeneratedDraftSchema>;

// CAD mode: the model names parts and writes the procedure around a fixed, deterministic install order.
export const CadDraftSchema = z.object({
  title: z.coerce.string().default("Assembly"),
  summary: z.coerce.string().default(""),
  domain: z.enum(["mechanical", "mechatronic"]).catch("mechanical").default("mechanical"),
  notes: z.coerce.string().default(""),
  parts: z.array(z.object({ id: z.coerce.string(), name: z.coerce.string(), category: z.enum(CATEGORIES as [PartCategory, ...PartCategory[]]).catch("other"), description: optText, symmetryDeg: optNum, color: optText })).default([]),
  steps: z.array(StepDraftSchema).default([]),
});
export type CadDraft = z.infer<typeof CadDraftSchema>;
