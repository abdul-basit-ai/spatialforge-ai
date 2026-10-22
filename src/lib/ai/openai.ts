import type { ZodType } from "zod";
import { errorMessage } from "@/lib/db/tls";

// The only module that calls OpenAI. Server-side only (reads OPENAI_API_KEY).
// MODEL: heavy reasoning (scene compiler, prompt-only generation). FAST_MODEL: Critic, Coach, vision step checks.
export const MODEL = process.env.OPENAI_MODEL || "gpt-5.5";
export const FAST_MODEL = process.env.OPENAI_FAST_MODEL || "gpt-5.4-mini";
const ENDPOINT = "https://api.openai.com/v1/responses";

export const openaiConfigured = () => Boolean(process.env.OPENAI_API_KEY);

export type InputPart = { type: "input_text"; text: string } | { type: "input_image"; image_url: string; detail?: "low" | "high" | "auto" } | { type: "input_file"; filename: string; file_data: string };
export type AiResult<T> = { ok: true; data: T; model: string; ms: number; citations: Array<{ title: string; url: string }> } | { ok: false; error: string; ms: number };

type Options = { model?: string; webSearch?: boolean; maxOutputTokens?: number; timeoutMs?: number; reasoning?: "minimal" | "low" | "medium" | "high" };

// Pulls the JSON object out of a reply that may be fenced or padded with prose.
export function extractJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  try { return JSON.parse(trimmed); } catch { /* fall through */ }
  const start = trimmed.indexOf("{"), end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON object in reply");
  return JSON.parse(trimmed.slice(start, end + 1));
}

// Responses API call that must return one JSON object matching `schema` (validated with zod; invalid output is an error, never applied).
// `input` is either plain text or multimodal parts (text, images as data URLs, PDFs as input_file data URLs).
export async function aiJson<T>(label: string, schema: ZodType<T>, instructions: string, input: string | InputPart[], options: Options = {}): Promise<AiResult<T>> {
  const key = process.env.OPENAI_API_KEY;
  const started = Date.now();
  if (!key) return { ok: false, error: "OPENAI_API_KEY not set", ms: 0 };
  const model = options.model ?? MODEL;
  // json_object mode requires the word "json" in the input itself, not just the instructions.
  const content: InputPart[] = [...(typeof input === "string" ? [{ type: "input_text" as const, text: input }] : input), { type: "input_text", text: "Respond in JSON." }];
  const body: Record<string, unknown> = {
    model,
    instructions: `${instructions}\n\nReply with a single JSON object only. No prose, no code fences.`,
    input: [{ role: "user", content }],
    max_output_tokens: options.maxOutputTokens ?? 16000,
    reasoning: { effort: options.reasoning ?? "low" },
  };
  if (options.webSearch) body.tools = [{ type: "web_search" }];
  else body.text = { format: { type: "json_object" } };
  try {
    const response = await fetch(ENDPOINT, { method: "POST", signal: AbortSignal.timeout(options.timeoutMs ?? 120000), headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const json = await response.json() as { model?: string; error?: { message?: string }; output?: Array<{ type: string; content?: Array<{ type: string; text?: string; annotations?: Array<{ type: string; title?: string; url?: string }> }> }> };
    if (!response.ok || json.error) throw new Error(`OpenAI HTTP ${response.status}: ${json.error?.message ?? "unknown"}`);
    const texts = (json.output ?? []).filter((item) => item.type === "message").flatMap((item) => item.content ?? []).filter((part) => part.type === "output_text");
    const text = texts.map((part) => part.text ?? "").join("\n");
    if (!text) throw new Error("empty reply");
    const citations = texts.flatMap((part) => part.annotations ?? []).filter((a) => a.type === "url_citation" && a.url).map((a) => ({ title: a.title ?? a.url!, url: a.url! }));
    const parsed = schema.safeParse(extractJson(text));
    if (!parsed.success) throw new Error(`invalid JSON shape: ${parsed.error.issues.slice(0, 4).map((issue) => `${issue.path.join(".")} ${issue.message}`).join("; ")}`);
    return { ok: true, data: parsed.data, model: json.model ?? model, ms: Date.now() - started, citations };
  } catch (error) {
    const message = errorMessage(error).slice(0, 400);
    console.error(`openai(${label}): ${message}`);
    return { ok: false, error: message, ms: Date.now() - started };
  }
}
