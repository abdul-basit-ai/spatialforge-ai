import { z } from "zod";
import { aiJson, MODEL } from "@/lib/ai/openai";
import { convertCad, detectCadFormat, type ConvertedCad } from "./cad-convert";
import type { CompileLog } from "./types";

// Prompt-only mode: web search for an openly licensed, directly downloadable CAD file, then download and convert it.

const MAX_BYTES = 20 * 1024 * 1024, TIMEOUT_MS = 15000, MAX_ATTEMPTS = 4, MIN_PARTS = 3;

const SearchSchema = z.object({
  candidates: z.array(z.object({
    title: z.string().default("CAD model"),
    url: z.string(),
    format: z.string().default(""),
    license: z.string().default("unknown"),
    notes: z.string().default(""),
  })).default([]),
});

export type WebCad = { converted: ConvertedCad; url: string; title: string; license: string; fileName: string; bytes: Buffer };
export type WebSearchOutcome = { cad: WebCad | null; citations: Array<{ title: string; url: string }>; tried: Array<{ url: string; result: string }> };

const SEARCH_INSTRUCTIONS = `You find CAD files for an assembly-training platform. Search the web for an openly licensed (CC, MIT, GPL, CERN-OHL, public domain, or a vendor CAD download that allows use) CAD model matching the request.
Hard requirements for every candidate URL:
- It must be a DIRECT file download over https that returns the raw file bytes with no login, no JavaScript page and no archive: .step/.stp, .stl, .glb or .iges/.igs.
- Good sources: raw.githubusercontent.com links, github.com ".../raw/..." links, gitlab "/-/raw/" links, university or vendor direct file links.
- Not acceptable: GrabCAD, Thingiverse, Printables, Cults, TraceParts, McMaster pages, Onshape/Fusion share links, .zip/.rar/.7z, Google Drive.
- Strongly prefer multi-body ASSEMBLIES (a STEP assembly with separate solids) over single parts; small files (< 20 MB).
Return {"candidates":[{"title","url","format","license","notes"}]} with up to 5 candidates, best first. Return an empty list rather than guessing URLs that you have not seen.`;

// SSRF guard: https only, public hostnames only.
export function safeUrl(raw: string): URL | null {
  try {
    let url = new URL(raw.trim());
    if (url.hostname === "github.com" && url.pathname.includes("/blob/")) url = new URL(`https://raw.githubusercontent.com${url.pathname.replace("/blob/", "/")}`);
    if (url.protocol !== "https:") return null;
    const host = url.hostname.toLowerCase();
    if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal") || /^\[|^\d+\.\d+\.\d+\.\d+$/.test(host)) return null;
    if (/\.(zip|rar|7z|gz|tar)$/i.test(url.pathname)) return null;
    return url;
  } catch { return null; }
}

export async function download(url: URL): Promise<{ bytes: Buffer; finalUrl: string; contentType: string }> {
  const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(TIMEOUT_MS), headers: { "User-Agent": "SpatialForge-compiler/1.0", Accept: "*/*" } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  if (!response.url.startsWith("https://")) throw new Error("redirected off https");
  const contentType = response.headers.get("content-type") ?? "";
  if (/text\/html/i.test(contentType)) throw new Error("got an HTML page, not a file");
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > MAX_BYTES) throw new Error(`file too large (${(declared / 1048576).toFixed(1)} MB)`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error("empty body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_BYTES) { await reader.cancel(); throw new Error("file larger than 20 MB"); }
    chunks.push(value);
  }
  return { bytes: Buffer.concat(chunks), finalUrl: response.url, contentType };
}

export async function findWebCad(request: string, log: CompileLog): Promise<WebSearchOutcome> {
  const outcome: WebSearchOutcome = { cad: null, citations: [], tried: [] };
  log.add("Searching the web for an openly licensed CAD file.");
  const search = await aiJson("forge-web-cad", SearchSchema, SEARCH_INSTRUCTIONS, `Assembly request: ${request}`, { model: MODEL, webSearch: true, reasoning: "low", timeoutMs: Math.min(75000, Math.max(20000, log.remaining() - 120000)), maxOutputTokens: 6000 });
  if (!search.ok) { log.add(`Web search failed: ${search.error}`); return outcome; }
  // Annotations are often empty with JSON replies; the candidate pages the search found are the citations then.
  outcome.citations = search.citations.length ? search.citations : search.data.candidates.map((c) => ({ title: `${c.title}${c.license && c.license !== "unknown" ? ` (${c.license})` : ""}`, url: c.url }));
  log.add(`Web search returned ${search.data.candidates.length} candidate(s) and ${search.citations.length} citation(s) in ${(search.ms / 1000).toFixed(1)}s.`);
  for (const candidate of search.data.candidates.slice(0, MAX_ATTEMPTS)) {
    if (log.remaining() < 110000) { log.add("Out of time budget for downloads; generating instead."); break; }
    const url = safeUrl(candidate.url);
    if (!url) { outcome.tried.push({ url: candidate.url, result: "rejected (not a safe direct https file link)" }); continue; }
    try {
      const file = await download(url);
      const fileName = decodeURIComponent(url.pathname.split("/").pop() || "model");
      const format = detectCadFormat(file.bytes, fileName);
      if (!format) throw new Error(`not a STEP/IGES/STL/GLB file (${file.contentType || "unknown type"})`);
      const converted = await convertCad(file.bytes, fileName, format, Math.min(60000, Math.max(10000, log.remaining() - 110000)));
      if (converted.parts.length < MIN_PARTS) throw new Error(`only ${converted.parts.length} body(ies); need an assembly`);
      outcome.tried.push({ url: url.href, result: `ok: ${format} with ${converted.parts.length} parts` });
      log.add(`Downloaded ${fileName} (${(file.bytes.length / 1024).toFixed(0)} KB, ${format.toUpperCase()}, ${converted.parts.length} parts) from ${url.hostname}.`);
      outcome.cad = { converted, url: url.href, title: candidate.title, license: candidate.license, fileName, bytes: file.bytes };
      return outcome;
    } catch (error) {
      const message = (error as Error).message.slice(0, 160);
      outcome.tried.push({ url: url.href, result: message });
      log.add(`Candidate ${url.hostname}${url.pathname.slice(0, 60)}: ${message}.`);
    }
  }
  return outcome;
}
