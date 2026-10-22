import type { ZodType } from "zod";
import { aiJson, FAST_MODEL, openaiConfigured } from "@/lib/ai/openai";

// Critic and Coach LLM entry point. Backed by OpenAI (src/lib/ai/openai.ts); JSON output validated with zod,
// anything invalid is discarded, never applied.
export const LLM_MODEL = FAST_MODEL;

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };
export type LlmResult<T> = { ok: true; data: T; model: string; ms: number } | { ok: false; error: string; ms: number };

export const llmConfigured = openaiConfigured;
export { extractJson } from "@/lib/ai/openai";

export async function completeJson<T>(label: string, schema: ZodType<T>, messages: ChatMessage[], { timeoutMs = 60000, maxTokens = 6000 }: { timeoutMs?: number; maxTokens?: number; temperature?: number } = {}): Promise<LlmResult<T>> {
  const instructions = messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n");
  const input = messages.filter((message) => message.role !== "system").map((message) => message.content).join("\n\n");
  const result = await aiJson(label, schema, instructions, input, { model: FAST_MODEL, timeoutMs, maxOutputTokens: maxTokens });
  return result.ok ? { ok: true, data: result.data, model: result.model, ms: result.ms } : result;
}
