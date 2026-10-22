import { NextResponse } from "next/server";
import { saveAsset } from "@/lib/forge/repo";
import { checkUpload, MAX_FILE_BYTES, MAX_TOTAL_BYTES } from "@/lib/forge/import/policy";
import { errorMessage } from "@/lib/db/tls";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST multipart/form-data: one or more "file" fields, optional "meta" (JSON object, stored with every file) and "scenarioId".
// Returns { id, name, mime, kind, size } for the first file plus { assets: [...] } for all of them.
export async function POST(request: Request) {
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > MAX_TOTAL_BYTES + 1024 * 1024) return NextResponse.json({ error: "Upload too large: the limit is 60 MB in total." }, { status: 413 });
  if (!(request.headers.get("content-type") ?? "").includes("multipart/form-data")) return NextResponse.json({ error: "Send multipart/form-data with one or more file fields." }, { status: 415 });
  let form: FormData;
  try { form = await request.formData(); } catch { return NextResponse.json({ error: "Could not read the multipart body." }, { status: 400 }); }
  const files = [...form.values()].filter((value): value is File => typeof value === "object" && value !== null && "arrayBuffer" in value);
  if (!files.length) return NextResponse.json({ error: "No files in the upload." }, { status: 400 });
  if (files.length > 20) return NextResponse.json({ error: "At most 20 files per upload." }, { status: 400 });
  const total = files.reduce((sum, file) => sum + file.size, 0);
  if (total > MAX_TOTAL_BYTES) return NextResponse.json({ error: `Upload is ${(total / 1048576).toFixed(1)} MB; the limit is 60 MB in total.` }, { status: 413 });

  let meta: Record<string, unknown> = {};
  const rawMeta = form.get("meta");
  if (typeof rawMeta === "string" && rawMeta) {
    if (rawMeta.length > 512 * 1024) return NextResponse.json({ error: "meta is too large (512 KB max)." }, { status: 400 });
    try { const parsed = JSON.parse(rawMeta); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) meta = parsed; } catch { return NextResponse.json({ error: "meta must be a JSON object." }, { status: 400 }); }
  }
  const scenarioRaw = form.get("scenarioId");
  const scenarioId = typeof scenarioRaw === "string" && /^[a-z0-9-]{1,80}$/.test(scenarioRaw) ? scenarioRaw : null;

  const checked = [];
  for (const file of files) {
    const name = (file.name || "upload").replace(/[\\/\0\r\n]/g, "_").slice(-160);
    if (file.size > MAX_FILE_BYTES) return NextResponse.json({ error: `${name} is ${(file.size / 1048576).toFixed(1)} MB; the limit is 25 MB per file.` }, { status: 413 });
    if (file.size === 0) return NextResponse.json({ error: `${name} is empty.` }, { status: 400 });
    const bytes = Buffer.from(await file.arrayBuffer());
    const verdict = checkUpload(name, file.type, new Uint8Array(bytes.subarray(0, 1024)));
    if ("error" in verdict) return NextResponse.json({ error: verdict.error }, { status: 415 });
    checked.push({ name, bytes, ...verdict });
  }
  try {
    const assets = [];
    for (const item of checked) {
      const id = await saveAsset({ name: item.name, mime: item.mime, bytes: item.bytes, scenarioId, meta: { ...meta, kind: item.kind, size: item.bytes.length, uploadedAt: new Date().toISOString() } });
      assets.push({ id, name: item.name, mime: item.mime, kind: item.kind, size: item.bytes.length, url: `/api/forge/assets/${id}` });
    }
    return NextResponse.json({ ...assets[0], assets }, { status: 201 });
  } catch (error) {
    console.error("forge assets upload", errorMessage(error));
    return NextResponse.json({ error: "Could not store the upload; try again." }, { status: 500 });
  }
}
