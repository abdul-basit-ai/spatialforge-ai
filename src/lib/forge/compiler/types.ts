import { z } from "zod";
import type { ForgeScenario, Quat, Vec3 } from "../types";

// Request/response shapes for POST /api/forge/compile.
const vec3 = z.tuple([z.number(), z.number(), z.number()]);
const quat = z.tuple([z.number(), z.number(), z.number(), z.number()]);

export const CadPartSchema = z.object({
  node: z.string().min(1).max(200),
  name: z.string().max(200).default(""),
  triangles: z.number().nonnegative().default(0),
  bbox: z.object({ min: vec3, max: vec3 }), // assembly frame (metres, Y-up)
  position: vec3.default([0, 0, 0]),
  quaternion: quat.default([0, 0, 0, 1]),
  color: z.string().max(32).optional(),
});

export const CompileRequestSchema = z.object({
  prompt: z.string().max(4000).optional(),
  domain: z.enum(["mechanical", "mechatronic"]).optional(),
  notes: z.string().max(4000).optional(),
  scenarioId: z.string().max(80).optional(), // recompile into an existing scenario (next version)
  assets: z.array(z.object({ id: z.string().max(64), name: z.string().max(300).default("file"), mime: z.string().max(120).default("application/octet-stream"), kind: z.string().max(40).default("other") })).max(20).default([]),
  cad: z.object({ assetId: z.string().max(64), parts: z.array(CadPartSchema).max(400) }).nullable().optional(),
});

export type CadPart = z.infer<typeof CadPartSchema>;
export type CompileRequest = z.infer<typeof CompileRequestSchema>;
export type CadInput = { assetId: string; parts: CadPart[] };
export type CompileResult = { scenario: ForgeScenario; issues: string[]; log: string[]; ms: number; citations: Array<{ title: string; url: string }> };

export type Box = { min: Vec3; max: Vec3 };
export type { Quat, Vec3 };

// Shared timer/log for one compile run.
export class CompileLog {
  readonly started = Date.now();
  readonly lines: string[] = [];
  constructor(readonly budgetMs = 225000) {}
  add(message: string) { const line = `[${((Date.now() - this.started) / 1000).toFixed(1)}s] ${message}`; this.lines.push(line); console.log(`forge-compile ${line}`); }
  elapsed() { return Date.now() - this.started; }
  remaining() { return this.budgetMs - this.elapsed(); }
}
