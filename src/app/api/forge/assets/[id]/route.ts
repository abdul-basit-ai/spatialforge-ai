import { NextResponse } from "next/server";
import { getAsset } from "@/lib/forge/repo";
import { errorMessage } from "@/lib/db/tls";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const INLINE = /^(model\/gltf-binary|application\/pdf|image\/(png|jpeg|webp))$/;

// Serves stored asset bytes. Assets are immutable by id, so they cache for a year.
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-zA-Z-]{8,64}$/.test(id)) return NextResponse.json({ error: "Bad asset id." }, { status: 400 });
  const etag = `"${id}"`;
  if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: { ETag: etag, "Cache-Control": "public, max-age=31536000, immutable" } });
  let asset;
  try { asset = await getAsset(id); } catch (error) { console.error("forge asset get", errorMessage(error)); return NextResponse.json({ error: "Could not read the asset." }, { status: 500 }); }
  if (!asset) return NextResponse.json({ error: "Asset not found." }, { status: 404 });
  const mime = INLINE.test(asset.mime) || /^model\//.test(asset.mime) ? asset.mime : "application/octet-stream";
  const filename = asset.name.replace(/[^\w.\- ]+/g, "_");
  return new Response(new Uint8Array(asset.bytes), {
    headers: {
      "Content-Type": mime,
      "Content-Length": String(asset.bytes.length),
      "Content-Disposition": `${INLINE.test(mime) ? "inline" : "attachment"}; filename="${filename}"`,
      "Cache-Control": "public, max-age=31536000, immutable",
      ETag: etag,
      "X-Content-Type-Options": "nosniff",
      "Access-Control-Allow-Origin": "*",
      ...(mime === "application/pdf" ? {} : { "Content-Security-Policy": "default-src 'none'; sandbox" }), // Chrome's PDF viewer needs plugins
    },
  });
}
