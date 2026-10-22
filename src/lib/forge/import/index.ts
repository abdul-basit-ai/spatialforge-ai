import * as THREE from "three";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { assemble, type ImportedAssembly, type ImportedPart, type RawFile, type Units } from "./assemble";
import { occtToRawFile, readOcctInBrowser, type OcctFormat } from "./occt";
import { readMeshFile } from "./meshes";
import { classifyFile, MAX_FILE_BYTES, MAX_TOTAL_BYTES, type FileRole } from "./policy";

// Browser-side import pipeline for the Studio: parse CAD -> one Forge assembly -> GLB -> /api/forge/assets -> /api/forge/compile.
export { assemble, humanizeName } from "./assemble";
export type { ImportedAssembly, ImportedPart, RawFile, Units } from "./assemble";
export { classifyFile, MAX_FILE_BYTES, MAX_TOTAL_BYTES } from "./policy";

export type UploadedAsset = { id: string; name: string; mime: string; kind: "mesh" | "pdf" | "image" };
export type CompileRequest = { prompt: string; domain: "mechanical" | "mechatronic"; notes: string; assets: UploadedAsset[]; cad: { assetId: string; parts: ImportedPart[] } | null };

// Parses every CAD/mesh file into one assembly (metres, Y-up, centred on the largest part).
export async function parseCadFiles(files: File[], options: { units?: Units; onFile?: (name: string, index: number) => void } = {}): Promise<ImportedAssembly> {
  const raws: RawFile[] = [];
  for (const [index, file] of files.entries()) {
    options.onFile?.(file.name, index);
    const kind = classifyFile(file.name, file.size);
    if ("error" in kind) throw new Error(kind.error);
    const buffer = await file.arrayBuffer();
    try {
      if (kind.role === "cad") raws.push(occtToRawFile(await readOcctInBrowser(buffer, kind.format as OcctFormat), file.name, kind.format as OcctFormat));
      else if (kind.role === "mesh") raws.push(await readMeshFile(file.name, kind.format as "stl" | "obj" | "glb", buffer));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(message.startsWith(file.name) ? message : `${file.name}: ${message}`);
    }
  }
  return assemble(raws, { units: options.units });
}

// Binary glTF of the assembly. Part nodes are exported at the identity pose (geometry local to the part origin);
// assembled poses travel in the parts list and in each node's extras, so buildPartObject(part) + applyTransform(part.assembled) is exact.
export async function exportAssemblyGlb(assembly: ImportedAssembly): Promise<ArrayBuffer> {
  const root = new THREE.Group();
  root.name = "forge_assembly";
  root.userData = { forge: { units: "m", up: "y", baseNode: assembly.baseNode, parts: assembly.parts.map(({ node, name, position, quaternion, bbox }) => ({ node, name, position, quaternion, bbox })) } };
  for (const holder of assembly.group.children) {
    const copy = holder.clone(true); // shares geometry and materials
    copy.position.set(0, 0, 0); copy.quaternion.identity(); copy.scale.set(1, 1, 1);
    root.add(copy);
  }
  const result = await new GLTFExporter().parseAsync(root, { binary: true, onlyVisible: false });
  if (!(result instanceof ArrayBuffer)) throw new Error("GLB export failed");
  return result;
}

async function readError(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  try { const json = JSON.parse(text) as { error?: string; message?: string }; return json.error ?? json.message ?? text; } catch { return text.slice(0, 300) || `HTTP ${response.status}`; }
}

// Uploads blobs to /api/forge/assets (one multipart request; the server enforces 25 MB per file and 60 MB in total).
export async function uploadAssets(items: Array<{ blob: Blob; name: string; kind: UploadedAsset["kind"] }>, meta?: Record<string, unknown>): Promise<UploadedAsset[]> {
  const total = items.reduce((sum, item) => sum + item.blob.size, 0);
  for (const item of items) if (item.blob.size > MAX_FILE_BYTES) throw new Error(`${item.name} is ${(item.blob.size / 1048576).toFixed(1)} MB; the limit is 25 MB per file.`);
  if (total > MAX_TOTAL_BYTES) throw new Error(`The upload is ${(total / 1048576).toFixed(1)} MB; the limit is 60 MB in total.`);
  if (!items.length) return [];
  const form = new FormData();
  for (const item of items) form.append("file", item.blob, item.name);
  if (meta) form.append("meta", JSON.stringify(meta));
  const response = await fetch("/api/forge/assets", { method: "POST", body: form });
  if (!response.ok) throw new Error(`Upload failed: ${await readError(response)}`);
  const json = await response.json() as { assets?: Array<{ id: string; name: string; mime: string }> } & { id?: string; name?: string; mime?: string };
  const list = json.assets ?? (json.id ? [{ id: json.id, name: json.name!, mime: json.mime! }] : []);
  return list.map((asset, index) => ({ id: asset.id, name: asset.name, mime: asset.mime, kind: items[index]?.kind ?? "mesh" }));
}

export type CompileProgress = { stage?: string; message?: string };
export type CompileOutcome = { id: string; scenario?: { id: string; issues?: string[]; parts?: unknown[]; steps?: unknown[]; title?: string } };

// POST /api/forge/compile. Accepts a JSON reply ({id} | {scenario}) or an NDJSON / SSE stream of progress objects ending with one.
export async function compileScenario(request: CompileRequest, onProgress?: (progress: CompileProgress) => void): Promise<CompileOutcome> {
  const response = await fetch("/api/forge/compile", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request) });
  if (response.status === 404) throw new Error("The scenario compiler is not available yet (/api/forge/compile returned 404).");
  if (!response.ok) throw new Error(`Compile failed: ${await readError(response)}`);
  const type = response.headers.get("content-type") ?? "";
  const finish = (value: Record<string, unknown>): CompileOutcome | null => {
    if (typeof value.error === "string" && value.ok !== true) throw new Error(`Compile failed: ${value.error}`);
    const scenario = value.scenario as CompileOutcome["scenario"] | undefined;
    const id = (value.id as string | undefined) ?? scenario?.id;
    return id ? { id, scenario } : null;
  };
  if (/ndjson|event-stream/.test(type) && response.body) {
    const reader = response.body.getReader(); const decoder = new TextDecoder();
    let buffer = "", outcome: CompileOutcome | null = null;
    const line = (raw: string) => {
      const text = raw.replace(/^data:\s*/, "").trim(); if (!text || text.startsWith(":") || text.startsWith("event:")) return;
      let value: Record<string, unknown>; try { value = JSON.parse(text); } catch { return; }
      if (value.stage || value.message) onProgress?.({ stage: value.stage as string | undefined, message: value.message as string | undefined });
      outcome = finish(value) ?? outcome;
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (value) { buffer += decoder.decode(value, { stream: true }); const lines = buffer.split("\n"); buffer = lines.pop() ?? ""; lines.forEach(line); }
      if (done) break;
    }
    line(buffer);
    if (!outcome) throw new Error("The compiler finished without returning a scenario.");
    return outcome;
  }
  const outcome = finish(await response.json() as Record<string, unknown>);
  if (!outcome) throw new Error("The compiler did not return a scenario id.");
  return outcome;
}

export const roleOf = (file: File): FileRole | null => { const kind = classifyFile(file.name, file.size); return "error" in kind ? null : kind.role; };
