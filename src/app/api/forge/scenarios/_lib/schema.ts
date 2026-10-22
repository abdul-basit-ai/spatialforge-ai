import { z } from "zod";
import { CATEGORIES, SHAPES, STEP_KINDS } from "@/components/forge/editor/constants";
import type { ForgeScenario } from "@/lib/forge/types";

// Zod mirror of src/lib/forge/types.ts used to validate editor saves. Loose objects keep additive optional fields from other roles.
const num = z.number().finite();
const vec3 = z.tuple([num, num, num]);
const quat = z.tuple([num, num, num, num]);
const text = (max: number) => z.string().max(max);
const list = (max: number, item = 400) => z.array(text(item)).max(max);

const enumOf = <T extends string>(values: readonly T[]) => z.enum(values as [T, ...T[]]);

const geometry = z.discriminatedUnion("kind", [
  z.looseObject({ kind: z.literal("mesh"), assetId: text(80), node: text(200) }),
  z.looseObject({ kind: z.literal("primitive"), shape: enumOf(SHAPES), params: z.record(z.string().max(40), num) }),
]);

const mate = z.looseObject({
  type: z.enum(["fixed", "axial", "planar"]),
  axis: vec3.optional(),
  positionTolerance: num,
  angleToleranceDeg: num,
  symmetryDeg: num.optional(),
});

const part = z.looseObject({
  id: text(80).min(1),
  name: text(160),
  category: enumOf(CATEGORIES),
  geometry,
  color: text(40).optional(),
  assembled: z.looseObject({ position: vec3, quaternion: quat }),
  mate,
  description: text(2000).optional(),
});

const step = z.looseObject({
  id: text(80).min(1),
  kind: enumOf(STEP_KINDS),
  title: text(200),
  instruction: text(4000),
  voiceLine: text(1000),
  partIds: z.array(text(80)).max(200),
  requires: z.array(text(80)).max(200),
  tool: text(120).optional(),
  torqueNm: num.optional(),
  pattern: text(200).optional(),
  target: z.looseObject({ label: text(120), value: num, unit: text(20), tolerance: num.optional() }).optional(),
  checklist: list(50).optional(),
  warnings: list(50).optional(),
  hints: list(50).optional(),
  commonMistakes: list(50).optional(),
  audio: z.looseObject({ url: text(2000), voiceId: text(80).optional() }).optional(),
});

const source = z.looseObject({
  kind: z.enum(["upload", "web", "generated", "builtin"]),
  files: z.array(z.looseObject({ name: text(300), mime: text(120), assetId: text(80).optional() })).max(100).optional(),
  urls: z.array(z.looseObject({ title: text(300), url: text(2000), license: text(200).optional() })).max(100).optional(),
  prompt: text(4000).optional(),
  approximation: z.boolean(),
  notes: text(8000).optional(),
});

export const scenarioSchema = z.looseObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,59}$/, "id must be a slug"),
  version: z.number().int().min(0).max(100000),
  status: z.enum(["draft", "published"]),
  title: text(200),
  summary: text(4000),
  domain: z.enum(["mechanical", "mechatronic"]),
  source,
  baseParts: z.array(text(80)).max(500),
  parts: z.array(part).max(2000),
  steps: z.array(step).max(1000),
  issues: z.array(z.string()).optional(),
  createdAt: z.string().max(40),
  updatedAt: z.string().max(40),
});

export type ParsedScenario = { ok: true; scenario: ForgeScenario } | { ok: false; error: string; details: string[] };

export function parseScenario(value: unknown): ParsedScenario {
  const result = scenarioSchema.safeParse(value);
  if (result.success) return { ok: true, scenario: result.data as unknown as ForgeScenario };
  const details = result.error.issues.slice(0, 20).map((issue) => `${issue.path.join(".") || "scenario"}: ${issue.message}`);
  return { ok: false, error: "Invalid scenario", details };
}

export const MAX_BODY_BYTES = 8 * 1024 * 1024;
