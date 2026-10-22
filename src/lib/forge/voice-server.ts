import { createHash } from "node:crypto";
import { postgres } from "@/lib/db/postgres";
import { errorMessage } from "@/lib/db/tls";
import { valkey, withTimeout } from "@/lib/db/valkey";
import type { ForgeScenario } from "./types";

// Server-side ElevenLabs synthesis with a three-level cache: process memory (LRU), Valkey (hot, short TTL, base64)
// and PostgreSQL forge_audio (permanent). Keys are sha256(voiceId|model|text). synthesize() returns null whenever
// ElevenLabs is unavailable (no key, quota, auth, rate limit, network), and callers fall back to browser speech.
export const FALLBACK_VOICE_ID = "EXAVITQu4vr4xnSDxMaL"; // "Sarah", a premade voice usable on every plan
export const MAX_TTS_CHARS = 600;
const OUTPUT_FORMAT = "mp3_44100_64";
const VALKEY_TTL_SECONDS = 60 * 60 * 6;
const MEMORY_ITEMS = 150;

export type AudioSource = "memory" | "valkey" | "postgres" | "elevenlabs";
export type SynthResult = { key: string; bytes: Buffer; mime: string; source?: AudioSource; voiceId?: string };

export const voiceConfig = () => ({
  apiKey: process.env.ELEVENLABS_API_KEY?.trim() || "",
  voiceId: process.env.ELEVENLABS_VOICE_ID?.trim() || FALLBACK_VOICE_ID,
  modelId: process.env.ELEVENLABS_MODEL_ID?.trim() || "eleven_flash_v2_5",
});
export const voiceConfigured = () => Boolean(voiceConfig().apiKey);

export function normalizeText(text: string) {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim();
  if (clean.length <= MAX_TTS_CHARS) return clean;
  const cut = clean.slice(0, MAX_TTS_CHARS);
  const sentence = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  return (sentence > MAX_TTS_CHARS * 0.6 ? cut.slice(0, sentence + 1) : cut.replace(/\s+\S*$/, "")).trim();
}

export function audioKey(text: string, config = voiceConfig()) {
  return createHash("sha256").update(`${config.voiceId}|${config.modelId}|${normalizeText(text)}`).digest("hex");
}
export const isAudioKey = (key: unknown): key is string => typeof key === "string" && /^[0-9a-f]{64}$/.test(key);
const valkeyKey = (key: string) => `sf:tts:${key}`;

type State = { memory: Map<string, Buffer>; inflight: Map<string, Promise<SynthResult | null>>; blockedUntil: number; logged: Set<string>; rejected: Set<string> };
const g = globalThis as typeof globalThis & { __forgeVoice?: State };
const state = (): State => (g.__forgeVoice ??= { memory: new Map(), inflight: new Map(), blockedUntil: 0, logged: new Set(), rejected: new Set() });

function logOnce(tag: string, message: string) {
  const s = state(); if (s.logged.has(tag)) return;
  s.logged.add(tag); console.warn(`[voice] ${message}`);
}

function remember(key: string, bytes: Buffer) {
  const mem = state().memory; mem.delete(key); mem.set(key, bytes);
  while (mem.size > MEMORY_ITEMS) mem.delete(mem.keys().next().value as string);
}

// Looks the key up in memory, then Valkey, then PostgreSQL (promoting hits to the faster levels).
export async function getAudio(key: string): Promise<SynthResult | null> {
  if (!isAudioKey(key)) return null;
  const hit = state().memory.get(key);
  if (hit) { remember(key, hit); return { key, bytes: hit, mime: "audio/mpeg", source: "memory" }; }
  const cache = valkey();
  if (cache) {
    try {
      const encoded = await withTimeout(cache.get(valkeyKey(key)), 1200);
      if (encoded) { const bytes = Buffer.from(encoded, "base64"); remember(key, bytes); return { key, bytes, mime: "audio/mpeg", source: "valkey" }; }
    } catch (error) { logOnce("valkey-read", `valkey read failed: ${errorMessage(error)}`); }
  }
  const pg = postgres();
  if (pg) {
    try {
      const { rows } = await pg.query(`select mime, bytes from forge_audio where key = $1`, [key]);
      if (rows[0]) {
        const bytes = rows[0].bytes as Buffer; remember(key, bytes); void warmValkey(key, bytes);
        return { key, bytes, mime: rows[0].mime || "audio/mpeg", source: "postgres" };
      }
    } catch (error) { logOnce("pg-read", `forge_audio read failed: ${errorMessage(error)}`); }
  }
  return null;
}

async function warmValkey(key: string, bytes: Buffer) {
  const cache = valkey(); if (!cache) return;
  try { await withTimeout(cache.set(valkeyKey(key), bytes.toString("base64"), "EX", VALKEY_TTL_SECONDS), 1500); }
  catch (error) { logOnce("valkey-write", `valkey write failed: ${errorMessage(error)}`); }
}

async function store(key: string, bytes: Buffer, text: string) {
  remember(key, bytes);
  const pg = postgres();
  await Promise.all([
    warmValkey(key, bytes),
    pg ? pg.query(`insert into forge_audio (key, mime, bytes, text) values ($1, 'audio/mpeg', $2, $3) on conflict (key) do nothing`, [key, bytes, text]).catch((error) => logOnce("pg-write", `forge_audio write failed: ${errorMessage(error)}`)) : null,
  ]);
}

async function callElevenLabs(text: string, config: ReturnType<typeof voiceConfig>, voiceId = config.voiceId): Promise<{ bytes: Buffer; voiceId: string } | null> {
  const s = state();
  if (Date.now() < s.blockedUntil) return null;
  if (s.rejected.has(voiceId)) voiceId = FALLBACK_VOICE_ID; // remembered: skip the doomed request
  let response: Response;
  try {
    response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=${OUTPUT_FORMAT}`, {
      method: "POST",
      headers: { "xi-api-key": config.apiKey, "content-type": "application/json", accept: "audio/mpeg" },
      body: JSON.stringify({ text, model_id: config.modelId, voice_settings: { stability: 0.5, similarity_boost: 0.75 } }),
      signal: AbortSignal.timeout(15000),
    });
  } catch (error) { logOnce("network", `ElevenLabs unreachable: ${errorMessage(error)}`); return null; }
  if (response.ok) {
    const bytes = Buffer.from(await response.arrayBuffer());
    return bytes.length > 100 ? { bytes, voiceId } : null;
  }
  const detail = (await response.text().catch(() => "")).slice(0, 200);
  // A configured voice the plan cannot use (402 paid_plan_required / 404): retry once with the premade voice.
  if ((response.status === 402 || response.status === 404 || response.status === 400) && voiceId !== FALLBACK_VOICE_ID && /voice|paid_plan|library/i.test(detail)) {
    s.rejected.add(voiceId);
    logOnce(`voice-${response.status}`, `voice ${voiceId} rejected (${response.status}); using premade fallback voice`);
    return callElevenLabs(text, config, FALLBACK_VOICE_ID);
  }
  if (response.status === 401 || response.status === 402) s.blockedUntil = Date.now() + 10 * 60_000; // bad key or out of credits
  else if (response.status === 429) s.blockedUntil = Date.now() + 20_000;
  logOnce(`status-${response.status}`, `ElevenLabs ${response.status}: ${detail || response.statusText}; falling back to browser speech`);
  return null;
}

// Returns mp3 bytes (cached or fresh) or null when ElevenLabs is unavailable.
export async function synthesize(text: string): Promise<SynthResult | null> {
  const clean = normalizeText(text);
  if (!clean) return null;
  const config = voiceConfig();
  const key = audioKey(clean, config);
  const cached = await getAudio(key);
  if (cached) return { ...cached, voiceId: config.voiceId };
  if (!config.apiKey) return null;
  const inflight = state().inflight;
  const pending = inflight.get(key);
  if (pending) return pending;
  const job = (async () => {
    const voiced = await callElevenLabs(clean, config);
    if (!voiced) return null;
    await store(key, voiced.bytes, clean);
    return { key, bytes: voiced.bytes, mime: "audio/mpeg", source: "elevenlabs" as const, voiceId: voiced.voiceId };
  })().finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}

export const audioUrl = (key: string) => `/api/forge/audio/${key}`;
export const introLine = (scenario: Pick<ForgeScenario, "title" | "summary">) =>
  normalizeText(`${scenario.title}. ${scenario.summary.split(/(?<=[.!?])\s/)[0] ?? ""} Let's begin.`);

async function pool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (next < items.length) await worker(items[next++]); }));
}

// Pre-generates audio for the intro and every step voiceLine (concurrency 3) and returns the scenario with
// step.audio = { url, voiceId } wherever synthesis succeeded. The intro lands on the additive `introAudio` field.
// Without an ElevenLabs key the scenario is returned unchanged.
export async function generateScenarioAudio(scenario: ForgeScenario): Promise<ForgeScenario> {
  if (!voiceConfigured()) return scenario;
  const lines = new Map<string, SynthResult | null>();
  const intro = introLine(scenario);
  for (const text of [intro, ...scenario.steps.map((step) => normalizeText(step.voiceLine || step.instruction || step.title))]) if (text) lines.set(text, null);
  await pool([...lines.keys()], 3, async (text) => { lines.set(text, await synthesize(text).catch(() => null)); });
  const steps = scenario.steps.map((step) => {
    const result = lines.get(normalizeText(step.voiceLine || step.instruction || step.title));
    return result ? { ...step, audio: { url: audioUrl(result.key), voiceId: result.voiceId } } : step;
  });
  const introResult = lines.get(intro);
  const out: ForgeScenario & { introAudio?: { url: string; voiceId?: string; text: string } } = { ...scenario, steps };
  if (introResult) out.introAudio = { url: audioUrl(introResult.key), voiceId: introResult.voiceId, text: intro };
  return out;
}

// Builds an audio/mpeg response with byte-range support (Safari requires 206 replies for media elements).
export function audioResponse(request: Request, audio: SynthResult, cacheControl: string, extra: Record<string, string> = {}) {
  const total = audio.bytes.length;
  const headers: Record<string, string> = { "content-type": audio.mime || "audio/mpeg", "cache-control": cacheControl, "accept-ranges": "bytes", etag: `"${audio.key}"`, ...extra };
  if (request.headers.get("if-none-match") === `"${audio.key}"`) return new Response(null, { status: 304, headers });
  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get("range") ?? "");
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : Math.max(0, total - Number(range[2]));
    let end = range[1] && range[2] ? Math.min(Number(range[2]), total - 1) : total - 1;
    if (start >= total || start > end) return new Response(null, { status: 416, headers: { ...headers, "content-range": `bytes */${total}` } });
    start = Math.max(0, start); end = Math.max(start, end);
    return new Response(new Uint8Array(audio.bytes.subarray(start, end + 1)), { status: 206, headers: { ...headers, "content-range": `bytes ${start}-${end}/${total}`, "content-length": String(end - start + 1) } });
  }
  return new Response(new Uint8Array(audio.bytes), { headers: { ...headers, "content-length": String(total) } });
}

// Fixed-window limiter for fresh synthesis per client IP (Valkey INCR, per-process fallback).
const localHits = new Map<string, number>();
export async function allowTts(request: Request, perMinute = Number(process.env.TTS_RATE_PER_MINUTE) || 40): Promise<boolean> {
  const ip = (request.headers.get("x-forwarded-for")?.split(",")[0] || request.headers.get("x-real-ip") || "local").trim().slice(0, 64);
  const key = `sf:rl:tts:${ip}:${Math.floor(Date.now() / 60000)}`;
  const local = () => {
    for (const old of localHits.keys()) if (!old.endsWith(key.slice(key.lastIndexOf(":")))) localHits.delete(old);
    const count = (localHits.get(key) || 0) + 1; localHits.set(key, count); return count <= perMinute;
  };
  const cache = valkey(); if (!cache) return local();
  try {
    const [[, count]] = await withTimeout(cache.multi().incr(key).expire(key, 90).exec() as Promise<Array<[Error | null, number]>>);
    return Number(count) <= perMinute;
  } catch { return local(); }
}
