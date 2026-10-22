import { allowTts, audioKey, audioResponse, getAudio, normalizeText, synthesize, voiceConfigured } from "@/lib/forge/voice-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/forge/tts?text=... -> audio/mpeg (cached or freshly synthesized by ElevenLabs). POST {text} works too.
// 204 means "no ElevenLabs audio right now": the client falls back to browser speech. Cache hits skip the rate limit.
const noAudio = (status: number, extra: Record<string, string> = {}) => new Response(null, { status, headers: { "cache-control": "no-store", ...extra } });

async function handle(request: Request, raw: unknown) {
  if (typeof raw !== "string" || !raw.trim()) return Response.json({ error: "text is required" }, { status: 400 });
  if (raw.length > 2000) return Response.json({ error: "text is too long" }, { status: 413 });
  const text = normalizeText(raw);
  const started = Date.now();
  const timing = () => ({ "server-timing": `tts;dur=${Date.now() - started}` });
  const cached = await getAudio(audioKey(text));
  if (cached) return audioResponse(request, cached, "public, max-age=86400", { "x-forge-audio": cached.source ?? "cache", "x-forge-audio-key": cached.key, ...timing() });
  if (!voiceConfigured()) return noAudio(204, { "x-forge-audio": "unconfigured" });
  if (!(await allowTts(request))) return noAudio(429, { "retry-after": "60", "x-forge-audio": "rate-limited" });
  const audio = await synthesize(text);
  if (!audio) return noAudio(204, { "x-forge-audio": "unavailable", ...timing() });
  return audioResponse(request, audio, "public, max-age=86400", { "x-forge-audio": audio.source ?? "elevenlabs", "x-forge-audio-key": audio.key, ...timing() });
}

export async function GET(request: Request) {
  return handle(request, new URL(request.url).searchParams.get("text"));
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  return handle(request, (body as { text?: unknown }).text);
}
