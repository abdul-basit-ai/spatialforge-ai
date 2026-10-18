import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const { text } = await request.json().catch(() => ({}));
  if (!text) return NextResponse.json({ error: "text is required" }, { status: 400 });
  const key = process.env.ELEVENLABS_API_KEY;
  const voice = process.env.ELEVENLABS_VOICE_ID;
  if (!key || !voice) return NextResponse.json({ mode: "browser-speech", text });
  const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}/stream?model_id=eleven_flash_v2_5`, { method:"POST", headers:{"xi-api-key":key,"content-type":"application/json","accept":"audio/mpeg"}, body:JSON.stringify({ text, model_id:"eleven_flash_v2_5" }) });
  if (!response.ok) return NextResponse.json({ error:"ElevenLabs request failed" }, { status:502 });
  return new Response(response.body, { headers:{"content-type":"audio/mpeg","cache-control":"no-store"} });
}
