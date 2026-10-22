import { NextResponse } from "next/server";
import { allowTts, audioKey, getAudio, synthesize, voiceConfigured } from "@/lib/forge/voice-server";

export const runtime = "nodejs";

// Legacy tray/valve voice endpoint. Same contract as before: audio/mpeg on success, {mode:"browser-speech", text}
// when ElevenLabs is not configured or unavailable, 400 without text. Now shares the Forge synthesis cache.
export async function POST(request: Request) {
  const { text } = await request.json().catch(() => ({}));
  if (!text || typeof text !== "string" || !text.trim()) return NextResponse.json({ error: "text is required" }, { status: 400 });
  const audio = (await getAudio(audioKey(text))) ?? (voiceConfigured() && (await allowTts(request)) ? await synthesize(text) : null);
  if (!audio) return NextResponse.json({ mode: "browser-speech", text });
  return new Response(new Uint8Array(audio.bytes), { headers: { "content-type": "audio/mpeg", "cache-control": "no-store", "x-forge-audio": audio.source ?? "elevenlabs" } });
}
