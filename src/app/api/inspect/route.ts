import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const { image, context } = await request.json().catch(() => ({}));
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return NextResponse.json({ mode:"deterministic", result:"AI inspection is disabled; deterministic virtual checks remain active." });
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", { method:"POST", headers:{Authorization:`Bearer ${key}`,"Content-Type":"application/json","HTTP-Referer":process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000","X-Title":"SpatialForge AI"}, body:JSON.stringify({ model:"z-ai/glm-5.3-flash", messages:[{role:"system",content:"You inspect a tray assembly image. Return compact JSON with keys ok, slot, orientation, note. Never invent certainty."},{role:"user",content:[{type:"text",text:`Context: ${context ?? "four-shape tray"}`},{type:"image_url",image_url:{url:image}}]}], provider:{allow_fallbacks:false,sort:"price"}, response_format:{type:"json_object"}, temperature:0 }) });
  if (!response.ok) return NextResponse.json({ error:"OpenRouter request failed" }, { status:502 });
  return NextResponse.json(await response.json());
}
