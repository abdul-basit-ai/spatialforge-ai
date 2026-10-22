import { NextResponse } from "next/server";
import { z } from "zod";
import { aiJson, FAST_MODEL, openaiConfigured } from "@/lib/ai/openai";
import { allowLlmCall, valkey } from "@/lib/db/valkey";
import { getScenario } from "@/lib/forge/repo";
import { builtinScenario } from "@/lib/forge/samples";
import type { ForgeScenario, ForgeStep } from "@/lib/forge/types";

// AR assist "Check my work": a camera frame of real hardware is judged against the current step by the fast vision model.
// This only advises the operator on REAL hardware; virtual placement correctness stays in the deterministic engine.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 1.5 * 1024 * 1024;
const MIN_PASS_CONFIDENCE = 0.7;
const MIMES: Record<string, (b: Buffer) => boolean> = {
  "image/jpeg": (b) => b[0] === 0xff && b[1] === 0xd8,
  "image/png": (b) => b[0] === 0x89 && b.toString("ascii", 1, 4) === "PNG",
  "image/webp": (b) => b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP",
};

const Body = z.object({ scenarioId: z.string().min(1).max(80), version: z.coerce.number().int().positive().optional(), stepId: z.string().min(1).max(120), image: z.string().min(32) });
const Judgement = z.object({
  status: z.enum(["pass", "fail", "unsure"]),
  confidence: z.coerce.number().min(0).max(1),
  message: z.string().max(400),
  observed: z.string().max(600).default(""),
});
type VerifyResult = z.infer<typeof Judgement> & { model?: string; ms?: number; available: boolean };

const reply = (body: VerifyResult | { error: string }, status = 200) => NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });

async function loadScenario(id: string, version?: number): Promise<ForgeScenario | null> {
  try {
    const exact = version ? await getScenario(id, { version }) : null;
    return exact ?? (await getScenario(id)) ?? builtinScenario(id);
  } catch (error) {
    console.error("verify-step: scenario lookup failed", error instanceof Error ? error.message : error);
    return builtinScenario(id);
  }
}

function describeStep(scenario: ForgeScenario, step: ForgeStep) {
  const names = (ids: string[]) => ids.map((id) => scenario.parts.find((part) => part.id === id)).filter(Boolean).map((part) => `${part!.name} (${part!.category}${part!.description ? `: ${part!.description}` : ""})`);
  const index = scenario.steps.findIndex((candidate) => candidate.id === step.id);
  const previous = step.requires.length ? scenario.steps.filter((candidate) => step.requires.includes(candidate.id)) : index > 0 ? [scenario.steps[index - 1]] : [];
  const lines = [
    `Assembly: ${scenario.title} (${scenario.domain}). ${scenario.summary}`,
    `Current step (${step.kind}): ${step.title}`,
    `Instruction: ${step.instruction}`,
    step.partIds.length ? `Parts in this step: ${names(step.partIds).join("; ")}` : "",
    step.tool ? `Tool: ${step.tool}` : "",
    step.torqueNm ? `Torque: ${step.torqueNm} N·m${step.pattern ? `, ${step.pattern}` : ""}` : step.pattern ? `Pattern: ${step.pattern}` : "",
    step.target ? `Target: ${step.target.label} = ${step.target.value} ${step.target.unit}` : "",
    step.checklist?.length ? `Checklist: ${step.checklist.join("; ")}` : "",
    step.warnings?.length ? `Warnings: ${step.warnings.join("; ")}` : "",
    step.commonMistakes?.length ? `Common mistakes to look for: ${step.commonMistakes.join("; ")}` : "",
    previous.length ? `Previous step(s), which should already be done: ${previous.map((p) => `${p.title}: ${p.instruction}`).join(" | ")}` : "This is the first step.",
  ];
  return lines.filter(Boolean).join("\n");
}

const INSTRUCTIONS = `You are a meticulous assembly inspector looking at one photo of REAL hardware taken by a technician in an AR assist app.
Decide whether the photo shows the CURRENT step correctly completed.
Rules:
- "pass" only if the relevant parts are clearly visible and correctly installed/oriented for this step.
- "fail" if you can see a specific problem (wrong part, wrong orientation, missing part, seated incorrectly, a listed common mistake). The message must be a short, spoken-style correction telling the technician exactly what to fix.
- "unsure" if the image is blurry, too dark, the parts are not visible, the photo is unrelated to the assembly, or you cannot judge. The message tells them how to retake the photo.
- confidence is 0..1 for your status. Be conservative: never claim pass without strong visual evidence.
- message: at most 2 short sentences, imperative, friendly, no markdown. observed: one sentence describing what you actually see.
Return JSON: {"status":"pass"|"fail"|"unsure","confidence":number,"message":string,"observed":string}`;

export async function POST(request: Request) {
  if (!(request.headers.get("content-type") ?? "").includes("application/json")) return reply({ error: "Send JSON: {scenarioId, version, stepId, image}" }, 415);
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BYTES * 1.4 + 4096) return reply({ error: "Image too large (max 1.5 MB)." }, 413);
  const raw = await request.text();
  if (raw.length > MAX_BYTES * 1.4 + 4096) return reply({ error: "Image too large (max 1.5 MB)." }, 413);
  let json: unknown;
  try { json = JSON.parse(raw); } catch { return reply({ error: "Invalid JSON." }, 400); }
  const parsed = Body.safeParse(json);
  if (!parsed.success) return reply({ error: `Invalid request: ${parsed.error.issues.slice(0, 3).map((issue) => `${issue.path.join(".")} ${issue.message}`).join("; ")}` }, 400);
  const { scenarioId, version, stepId, image } = parsed.data;

  const match = /^data:(image\/[a-z+.-]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(image);
  if (!match) return reply({ error: "image must be a base64 data URL (image/jpeg, image/png or image/webp)." }, 415);
  const mime = match[1].toLowerCase();
  const check = MIMES[mime];
  if (!check) return reply({ error: `Unsupported image type ${mime}.` }, 415);
  const bytes = Buffer.from(match[2], "base64");
  if (bytes.length > MAX_BYTES) return reply({ error: "Image too large (max 1.5 MB)." }, 413);
  if (bytes.length < 64 || !check(bytes)) return reply({ error: "Image data does not match its content type." }, 415);

  const scenario = await loadScenario(scenarioId, version);
  if (!scenario) return reply({ error: `Scenario ${scenarioId} not found.` }, 404);
  const step = scenario.steps.find((candidate) => candidate.id === stepId);
  if (!step) return reply({ error: `Step ${stepId} not found in ${scenarioId}.` }, 404);

  if (!openaiConfigured()) return reply({ status: "unsure", confidence: 0, message: "Automatic checking is offline. Compare your work with the ghost and confirm it yourself.", observed: "", available: false });
  const ip = (request.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "local";
  const cache = valkey();
  if (!(await allowLlmCall(cache, `verify:${ip}`, 12)) || !(await allowLlmCall(cache, "verify", 90))) {
    return reply({ status: "unsure", confidence: 0, message: "Too many checks in a minute. Wait a moment, or confirm the step yourself.", observed: "", available: false }, 429);
  }

  const result = await aiJson("verify-step", Judgement, INSTRUCTIONS, [
    { type: "input_text", text: describeStep(scenario, step) },
    { type: "input_image", image_url: `data:${mime};base64,${bytes.toString("base64")}`, detail: "low" },
  ], { model: FAST_MODEL, maxOutputTokens: 1200, timeoutMs: 30000, reasoning: "low" });
  if (!result.ok) return reply({ status: "unsure", confidence: 0, message: "I could not check that photo. Try again, or confirm the step yourself.", observed: "", available: false });

  const judged = result.data;
  const confidence = Math.round(Math.max(0, Math.min(1, judged.confidence)) * 100) / 100;
  // Never report a pass below the confidence floor: downgrade to unsure and ask for manual confirmation.
  const lowPass = judged.status === "pass" && confidence < MIN_PASS_CONFIDENCE;
  const status = lowPass ? "unsure" : judged.status;
  const message = lowPass ? `It looks close, but I am not certain. ${judged.message} Confirm it yourself if it matches the ghost.`.slice(0, 400) : judged.message;
  return reply({ status, confidence, message, observed: judged.observed, model: result.model, ms: result.ms, available: true });
}
