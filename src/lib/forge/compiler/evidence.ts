import { extractText, getDocumentProxy } from "unpdf";
import type { InputPart } from "@/lib/ai/openai";
import { getAsset } from "../repo";
import { detectCadFormat, type CadFormat } from "./cad-convert";
import type { CompileLog, CompileRequest } from "./types";

// Evidence gathering: PDF text (+ the PDF itself for OpenAI), images as data URLs, raw CAD uploads for server-side conversion.

const PDF_TEXT_CAP = 40000, PDF_FILE_CAP = 10 * 1024 * 1024, IMAGE_CAP = 8 * 1024 * 1024, MAX_IMAGES = 6;

export type Evidence = {
  text: string; // extracted manual text (capped)
  media: InputPart[]; // input_file / input_image parts
  files: Array<{ name: string; mime: string; assetId: string }>;
  cadFiles: Array<{ assetId: string; name: string; bytes: Buffer; format: CadFormat }>;
};

export async function gatherEvidence(assets: CompileRequest["assets"], log: CompileLog): Promise<Evidence> {
  const evidence: Evidence = { text: "", media: [], files: [], cadFiles: [] };
  let images = 0;
  for (const ref of assets) {
    const asset = await getAsset(ref.id).catch(() => null);
    if (!asset) { log.add(`Asset ${ref.name} (${ref.id}) not found; skipped.`); continue; }
    const mime = asset.mime || ref.mime;
    const name = asset.name || ref.name;
    evidence.files.push({ name, mime, assetId: ref.id });
    const isPdf = mime === "application/pdf" || /\.pdf$/i.test(name) || asset.bytes.subarray(0, 5).toString("latin1") === "%PDF-";
    if (isPdf) {
      try {
        const pdf = await getDocumentProxy(new Uint8Array(asset.bytes));
        const { text, totalPages } = await extractText(pdf, { mergePages: true });
        const body = String(text).replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
        const room = PDF_TEXT_CAP - evidence.text.length;
        if (room > 200) evidence.text += `\n\n=== ${name} (${totalPages} pages) ===\n${body.slice(0, room)}`;
        log.add(`PDF ${name}: ${totalPages} page(s), ${body.length} characters of text${body.length > room ? " (truncated)" : ""}.`);
      } catch (error) { log.add(`PDF ${name}: text extraction failed (${(error as Error).message}).`); }
      if (asset.bytes.length < PDF_FILE_CAP) {
        evidence.media.push({ type: "input_file", filename: name.replace(/[^\w. -]/g, "_") || "manual.pdf", file_data: `data:application/pdf;base64,${asset.bytes.toString("base64")}` });
        log.add(`PDF ${name}: attached for visual reading (${(asset.bytes.length / 1024).toFixed(0)} KB).`);
      } else log.add(`PDF ${name}: larger than 10 MB, sending text only.`);
      continue;
    }
    if (mime.startsWith("image/")) {
      if (images >= MAX_IMAGES || asset.bytes.length > IMAGE_CAP) { log.add(`Image ${name}: skipped (limit ${MAX_IMAGES} images, 8 MB each).`); continue; }
      images++;
      evidence.media.push({ type: "input_image", image_url: `data:${mime};base64,${asset.bytes.toString("base64")}`, detail: "high" });
      log.add(`Image ${name}: attached.`);
      continue;
    }
    const format = detectCadFormat(asset.bytes, name);
    if (format) { evidence.cadFiles.push({ assetId: ref.id, name, bytes: asset.bytes, format }); log.add(`CAD ${name}: ${format.toUpperCase()} file, will convert server-side.`); continue; }
    if (mime.startsWith("text/") && asset.bytes.length < 200000) {
      evidence.text += `\n\n=== ${name} ===\n${asset.bytes.toString("utf8").slice(0, Math.max(0, PDF_TEXT_CAP - evidence.text.length))}`;
      log.add(`Text ${name}: attached.`);
      continue;
    }
    log.add(`Asset ${name} (${mime}): not a supported evidence type; recorded only.`);
  }
  return evidence;
}
