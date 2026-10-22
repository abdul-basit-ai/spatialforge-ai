import type { ZodType } from "zod";
import { errorMessage } from "@/lib/db/tls";

// Shared OpenRouter client for the Critic and Coach agents. One pinned model, no provider fallbacks,
// JSON output validated with zod: anything invalid is discarded, never applied.
export const LLM_MODEL = "z-ai/glm-5.3-flash";
const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };
export type LlmResult<T> = { ok: true; data: T; model: string; ms: number } | { ok: false; error: string; ms: number };

export const llmConfigured = () => Boolean(process.env.OPENROUTER_API_KEY);

// Pulls the JSON object out of a reply that may be fenced or padded with prose.
export function extractJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  try { return JSON.parse(trimmed); } catch { /* fall through */ }
  const start = trimmed.indexOf("{"), end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON object in reply");
  return JSON.parse(trimmed.slice(start, end + 1));
}

// The model is a reasoning model, so max_tokens is generous to leave room for reasoning before the JSON answer.
export async function completeJson<T>(label: string, schema: ZodType<T>, messages: ChatMessage[], { maxTokens = 4096, timeoutMs = 60000, temperature = 0.2 } = {}): Promise<LlmResult<T>> {
  const key = process.env.OPENROUTER_API_KEY;
  const started = Date.now();
  if (!key) return { ok: false, error: "OPENROUTER_API_KEY not set", ms: 0 };
  try {
    const response = await fetch(ENDPOINT, {
      method: "POST", signal: AbortSignal.timeout(timeoutMs),
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "X-Title": "SpatialForge AI" },
      body: JSON.stringify({ model: LLM_MODEL, messages, provider: { allow_fallbacks: false }, response_format: { type: "json_object" }, temperature, max_tokens: maxTokens }),
    });
    if (!response.ok) throw new Error(`OpenRouter HTTP ${response.status}`);
    const body = await response.json() as { model?: string; choices?: Array<{ message?: { content?: string | null }; finish_reason?: string }>; error?: { message?: string } };
    if (body.error) throw new Error(`OpenRouter error: ${body.error.message ?? "unknown"}`);
    const content = body.choices?.[0]?.message?.content;
    if (!content) throw new Error(`empty reply (finish_reason ${body.choices?.[0]?.finish_reason ?? "unknown"})`);
    const parsed = schema.safeParse(extractJson(content));
    if (!parsed.success) throw new Error(`invalid JSON shape: ${parsed.error.issues.slice(0, 3).map((issue) => `${issue.path.join(".")} ${issue.message}`).join("; ")}`);
    return { ok: true, data: parsed.data, model: body.model ?? LLM_MODEL, ms: Date.now() - started };
  } catch (error) {
    const message = errorMessage(error).slice(0, 300);
    console.error(`llm(${label}): ${message}`);
    return { ok: false, error: message, ms: Date.now() - started };
  }
}
