import { audioResponse, getAudio, isAudioKey } from "@/lib/forge/voice-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/forge/audio/<sha256> -> cached ElevenLabs mp3. Content-addressed, so browsers may cache it forever.
export async function GET(request: Request, { params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  if (!isAudioKey(key)) return Response.json({ error: "invalid key" }, { status: 400 });
  const audio = await getAudio(key);
  if (!audio) return Response.json({ error: "not found" }, { status: 404, headers: { "cache-control": "no-store" } });
  return audioResponse(request, audio, "public, max-age=31536000, immutable", { "x-forge-audio": audio.source ?? "cache" });
}
