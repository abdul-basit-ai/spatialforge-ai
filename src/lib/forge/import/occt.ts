import * as THREE from "three";
import type { RawFile, RawPart } from "./assemble";

// STEP / IGES / BREP through occt-import-js (OpenCascade compiled to WebAssembly).
// The browser runs it in a worker (public/occt/forge-occt-worker.js, wasm at /occt/occt-import-js.wasm);
// Node tests pass the result of occt.ReadStepFile straight to occtToRawFile.

export type OcctFormat = "step" | "iges" | "brep";
type NumArray = ArrayLike<number>;
export type OcctMesh = { name?: string; color?: number[]; brep_faces?: Array<{ first: number; last: number; color: number[] | null }>; attributes: { position: { array: NumArray }; normal?: { array: NumArray } }; index?: { array: NumArray } };
export type OcctNode = { name?: string; meshes: number[]; children: OcctNode[] };
export type OcctResult = { success: boolean; root: OcctNode; meshes: OcctMesh[] };

// Tessellation: finer for small files, coarser for big ones so the GLB stays under the upload cap. Output in metres.
export const occtParams = (bytes: number) => ({ linearUnit: "meter", linearDeflectionType: "bounding_box_ratio", linearDeflection: bytes > 12e6 ? 0.004 : bytes > 4e6 ? 0.002 : 0.001, angularDeflection: 0.5 });

export function occtToRawFile(result: OcctResult, file: string, format: OcctFormat): RawFile {
  if (!result?.success) throw new Error(`${file}: OpenCascade could not read this ${format.toUpperCase()} file.`);
  const parts: RawPart[] = [];
  const walk = (node: OcctNode, path: string[]) => {
    const here = node.name ? [...path, node.name] : path;
    for (const index of node.meshes ?? []) {
      const mesh = result.meshes[index];
      if (!mesh) continue;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(Float32Array.from(mesh.attributes.position.array), 3));
      if (mesh.attributes.normal) geometry.setAttribute("normal", new THREE.BufferAttribute(Float32Array.from(mesh.attributes.normal.array), 3));
      if (mesh.index) geometry.setIndex(new THREE.BufferAttribute(Uint32Array.from(mesh.index.array), 1));
      const faceColor = mesh.brep_faces?.find((face) => face.color)?.color ?? undefined;
      const color = (mesh.color ?? faceColor) as [number, number, number] | undefined;
      parts.push({ name: mesh.name ?? "", path: here, color, geometry });
    }
    for (const child of node.children ?? []) walk(child, here);
  };
  walk(result.root, []);
  if (!parts.length) throw new Error(`${file}: the ${format.toUpperCase()} file has no solids (it may contain only curves or surfaces).`);
  return { file, format, parts, units: "m", up: "z" };
}

// ---- browser loading ----

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, { resolve: (result: OcctResult) => void; reject: (error: Error) => void }>();

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker("/occt/forge-occt-worker.js");
  worker.onmessage = (event: MessageEvent<{ id: number; result?: OcctResult; error?: string }>) => {
    const job = pending.get(event.data.id); if (!job) return;
    pending.delete(event.data.id);
    if (event.data.result) job.resolve(event.data.result); else job.reject(new Error(event.data.error ?? "CAD worker failed"));
  };
  worker.onerror = (event) => {
    for (const job of pending.values()) job.reject(new Error(`CAD worker crashed: ${event.message || "out of memory?"}`));
    pending.clear(); worker?.terminate(); worker = null;
  };
  return worker;
}

// Starts the worker (and its 7.6 MB wasm compile) ahead of the first drop.
export function warmCadEngine() { try { if (typeof Worker !== "undefined") getWorker(); } catch { /* parse falls back to the main thread */ } }

type OcctLib ={ ReadStepFile: (c: Uint8Array, p: unknown) => OcctResult; ReadIgesFile: (c: Uint8Array, p: unknown) => OcctResult; ReadBrepFile: (c: Uint8Array, p: unknown) => OcctResult };
let mainThread: Promise<OcctLib> | null = null;

// Fallback when workers are unavailable: load the emscripten script on the page.
function loadOnMainThread(): Promise<OcctLib> {
  return (mainThread ??= new Promise<OcctLib>((resolve, reject) => {
    const w = window as unknown as { occtimportjs?: (o: unknown) => Promise<OcctLib> };
    const init = () => w.occtimportjs!({ locateFile: (file: string) => `/occt/${file}` }).then(resolve, reject);
    if (w.occtimportjs) { init(); return; }
    const script = document.createElement("script");
    script.src = "/occt/occt-import-js.js"; script.async = true;
    script.onload = init; script.onerror = () => reject(new Error("Could not load the CAD engine (/occt/occt-import-js.js)."));
    document.head.appendChild(script);
  }));
}

export async function readOcctInBrowser(buffer: ArrayBuffer, format: OcctFormat): Promise<OcctResult> {
  const params = occtParams(buffer.byteLength);
  if (typeof Worker !== "undefined") {
    try {
      return await new Promise<OcctResult>((resolve, reject) => {
        const id = ++seq;
        const copy = buffer.slice(0); // transfer a copy so the main-thread fallback still has the bytes
        pending.set(id, { resolve, reject });
        getWorker().postMessage({ id, format, buffer: copy, params }, [copy]);
      });
    } catch (error) {
      if (/could not read|no solids/i.test(String(error))) throw error; // a real parse failure; retrying on the main thread won't help
      console.warn("CAD worker unavailable, parsing on the main thread", error);
    }
  }
  const lib = await loadOnMainThread();
  const content = new Uint8Array(buffer);
  return format === "iges" ? lib.ReadIgesFile(content, params) : format === "brep" ? lib.ReadBrepFile(content, params) : lib.ReadStepFile(content, params);
}
