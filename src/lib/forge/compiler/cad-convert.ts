import { createRequire } from "node:module";
import path from "node:path";
import * as THREE from "three";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { writeGlb, type GlbMesh } from "./glb";
import type { CadPart, Vec3 } from "./types";

// Server-side CAD conversion: STEP/IGES (occt-import-js WASM), STL (three's STLLoader, split into connected bodies)
// and GLB (minimal reader) -> named parts in the Forge assembly frame (metres, Y-up, base centred at the origin) + a GLB asset.

export type CadFormat = "step" | "iges" | "stl" | "glb";
type RawMesh = { name: string; positions: Float32Array; indices?: Uint32Array; color?: [number, number, number] };
export type ConvertedCad = { parts: CadPart[]; glb: Buffer; notes: string[]; format: CadFormat };

const MAX_PARTS = 80;

export function detectCadFormat(bytes: Buffer, name = ""): CadFormat | null {
  const head = bytes.subarray(0, 512).toString("latin1");
  const ext = name.toLowerCase().split("?")[0].split(".").pop() ?? "";
  if (head.startsWith("glTF")) return "glb";
  if (/^\s*ISO-10303-21/.test(head)) return "step";
  if (/^.{72}[SG]\s*\d{7}/m.test(head.slice(0, 82)) || ((ext === "igs" || ext === "iges") && /[SG]\s*\d{7}/.test(head))) return "iges";
  if (/^\s*<(!doctype|html|\?xml)/i.test(head)) return null; // login or landing page
  if (/^\s*solid\s/i.test(head) && /facet\s+normal/i.test(bytes.subarray(0, 4096).toString("latin1"))) return "stl";
  if (bytes.length > 84) {
    const triangles = bytes.readUInt32LE(80);
    if (84 + triangles * 50 === bytes.length) return "stl";
  }
  if (ext === "stl" && bytes.length > 84) return "stl";
  return null;
}

// occt-import-js is loaded at runtime (not bundled) so its WASM file resolves from node_modules.
let occtPromise: Promise<OcctModule> | null = null;
type OcctNode = { name?: string; meshes?: number[]; children?: OcctNode[] };
type OcctMesh = { name?: string; color?: number[]; attributes: { position: { array: number[] } }; index?: { array: number[] } };
type OcctResult = { success: boolean; root?: OcctNode; meshes?: OcctMesh[] };
type OcctModule = { ReadStepFile: (c: Uint8Array, p: unknown) => OcctResult; ReadIgesFile: (c: Uint8Array, p: unknown) => OcctResult };
function occt(): Promise<OcctModule> {
  if (!occtPromise) {
    // Built-in lookup keeps webpack from rewriting createRequire inside the Next server bundle.
    const nodeModule = (process as unknown as { getBuiltinModule?: (id: string) => typeof import("node:module") }).getBuiltinModule?.("node:module");
    const nodeRequire = (nodeModule?.createRequire ?? createRequire)(path.join(process.cwd(), "package.json"));
    const entry = nodeRequire.resolve("occt-import-js");
    const factory = nodeRequire(entry) as (options: { locateFile: (file: string) => string }) => Promise<OcctModule>;
    occtPromise = factory({ locateFile: (file) => path.join(path.dirname(entry), file) });
    occtPromise.catch(() => { occtPromise = null; });
  }
  return occtPromise;
}

async function readOcct(bytes: Buffer, format: "step" | "iges"): Promise<RawMesh[]> {
  const module = await occt();
  const params = { linearUnit: "meter", linearDeflectionType: "bounding_box_ratio", linearDeflection: 0.002, angularDeflection: 0.5 };
  const result = format === "step" ? module.ReadStepFile(new Uint8Array(bytes), params) : module.ReadIgesFile(new Uint8Array(bytes), params);
  if (!result.success || !result.meshes?.length) throw new Error(`${format.toUpperCase()} file could not be read`);
  const meshName = new Map<number, string>();
  const walk = (node: OcctNode, trail: string) => {
    const label = node.name?.trim() || trail;
    for (const index of node.meshes ?? []) meshName.set(index, label);
    for (const child of node.children ?? []) walk(child, label);
  };
  if (result.root) walk(result.root, "Part");
  return result.meshes.map((mesh, i) => ({
    name: mesh.name?.trim() || meshName.get(i) || `Part ${i + 1}`,
    positions: new Float32Array(mesh.attributes.position.array),
    indices: mesh.index ? new Uint32Array(mesh.index.array) : undefined,
    color: mesh.color && mesh.color.length >= 3 ? [mesh.color[0], mesh.color[1], mesh.color[2]] : undefined,
  }));
}

// STL is one triangle soup; weld vertices and split it into connected bodies (each body becomes a part).
function readStl(bytes: Buffer, name: string): RawMesh[] {
  const geometry = new STLLoader().parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  const pos = geometry.getAttribute("position").array as Float32Array;
  const triCount = pos.length / 9;
  const box = new THREE.Box3().setFromBufferAttribute(geometry.getAttribute("position") as THREE.BufferAttribute);
  const quantum = Math.max(1e-9, box.getSize(new THREE.Vector3()).length() * 1e-6);
  const ids = new Map<string, number>(), vertexOf = new Uint32Array(triCount * 3);
  for (let v = 0; v < triCount * 3; v++) {
    const key = `${Math.round(pos[v * 3] / quantum)},${Math.round(pos[v * 3 + 1] / quantum)},${Math.round(pos[v * 3 + 2] / quantum)}`;
    let id = ids.get(key);
    if (id === undefined) { id = ids.size; ids.set(key, id); }
    vertexOf[v] = id;
  }
  const parent = new Int32Array(ids.size).map((_, i) => i);
  const find = (x: number): number => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  for (let t = 0; t < triCount; t++) { const a = find(vertexOf[t * 3]); for (const b of [find(vertexOf[t * 3 + 1]), find(vertexOf[t * 3 + 2])]) if (a !== b) parent[b] = a; }
  const groups = new Map<number, number[]>();
  for (let t = 0; t < triCount; t++) { const root = find(vertexOf[t * 3]); const list = groups.get(root) ?? []; list.push(t); groups.set(root, list); }
  const base = name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim() || "Body";
  const sorted = [...groups.values()].sort((a, b) => b.length - a.length).filter((list, i, all) => i === 0 || list.length >= Math.max(12, all[0].length * 0.002));
  return sorted.map((tris, i) => {
    const positions = new Float32Array(tris.length * 9);
    tris.forEach((t, j) => positions.set(pos.subarray(t * 9, t * 9 + 9), j * 9));
    return { name: sorted.length === 1 ? base : `${base} body ${i + 1}`, positions };
  });
}

// Minimal GLB reader: walks the node tree, bakes world transforms, reads POSITION + indices (no Draco/meshopt).
function readGlb(bytes: Buffer): RawMesh[] {
  const jsonLength = bytes.readUInt32LE(12);
  const json = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString("utf8")) as {
    nodes?: Array<{ name?: string; mesh?: number; children?: number[]; matrix?: number[]; translation?: number[]; rotation?: number[]; scale?: number[] }>;
    meshes?: Array<{ name?: string; primitives: Array<{ attributes: { POSITION?: number }; indices?: number; material?: number }> }>;
    accessors?: Array<{ bufferView?: number; byteOffset?: number; componentType: number; count: number; type: string }>;
    bufferViews?: Array<{ byteOffset?: number; byteLength: number; byteStride?: number }>;
    materials?: Array<{ pbrMetallicRoughness?: { baseColorFactor?: number[] } }>;
    scenes?: Array<{ nodes?: number[] }>; scene?: number; extensionsUsed?: string[];
  };
  if (json.extensionsUsed?.some((ext) => /draco|meshopt/i.test(ext))) throw new Error("compressed glTF is not supported server-side");
  const binStart = 20 + jsonLength + 8;
  const read = (index: number, size: number): Float32Array | Uint32Array => {
    const accessor = json.accessors![index], view = json.bufferViews![accessor.bufferView ?? 0];
    const start = binStart + (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
    const width = { 5126: 4, 5125: 4, 5123: 2, 5121: 1 }[accessor.componentType] ?? 4;
    const stride = view.byteStride ?? width * size;
    const out = accessor.componentType === 5126 ? new Float32Array(accessor.count * size) : new Uint32Array(accessor.count * size);
    for (let i = 0; i < accessor.count; i++) for (let k = 0; k < size; k++) {
      const at = start + i * stride + k * width;
      out[i * size + k] = accessor.componentType === 5126 ? bytes.readFloatLE(at) : width === 4 ? bytes.readUInt32LE(at) : width === 2 ? bytes.readUInt16LE(at) : bytes.readUInt8(at);
    }
    return out;
  };
  const meshes: RawMesh[] = [];
  const visit = (index: number, parentMatrix: THREE.Matrix4) => {
    const node = json.nodes![index];
    const local = new THREE.Matrix4();
    if (node.matrix) local.fromArray(node.matrix);
    else local.compose(new THREE.Vector3(...((node.translation ?? [0, 0, 0]) as Vec3)), new THREE.Quaternion(...((node.rotation ?? [0, 0, 0, 1]) as [number, number, number, number])), new THREE.Vector3(...((node.scale ?? [1, 1, 1]) as Vec3)));
    const world = parentMatrix.clone().multiply(local);
    if (node.mesh !== undefined) {
      const mesh = json.meshes![node.mesh];
      const positions: number[] = [];
      let color: [number, number, number] | undefined;
      for (const primitive of mesh.primitives) {
        if (primitive.attributes.POSITION === undefined) continue;
        const p = read(primitive.attributes.POSITION, 3) as Float32Array;
        const idx = primitive.indices !== undefined ? read(primitive.indices, 1) : null;
        const v = new THREE.Vector3();
        const emit = (i: number) => { v.set(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]).applyMatrix4(world); positions.push(v.x, v.y, v.z); };
        if (idx) for (const i of idx) emit(i); else for (let i = 0; i < p.length / 3; i++) emit(i);
        const factor = json.materials?.[primitive.material ?? -1]?.pbrMetallicRoughness?.baseColorFactor;
        if (factor && !color) color = [factor[0], factor[1], factor[2]];
      }
      if (positions.length) meshes.push({ name: node.name || mesh.name || `Part ${meshes.length + 1}`, positions: new Float32Array(positions), color });
    }
    for (const child of node.children ?? []) visit(child, world);
  };
  for (const root of json.scenes?.[json.scene ?? 0]?.nodes ?? []) visit(root, new THREE.Matrix4());
  return meshes;
}

export async function convertCad(bytes: Buffer, name: string, format: CadFormat): Promise<ConvertedCad> {
  const notes: string[] = [];
  let raw = format === "stl" ? readStl(bytes, name) : format === "glb" ? readGlb(bytes) : await readOcct(bytes, format);
  raw = raw.filter((mesh) => mesh.positions.length >= 9);
  if (!raw.length) throw new Error("no geometry found in CAD file");
  if (raw.length > MAX_PARTS) {
    const size = (m: RawMesh) => m.positions.length;
    raw = [...raw].sort((a, b) => size(b) - size(a)).slice(0, MAX_PARTS);
    notes.push(`Kept the ${MAX_PARTS} largest of the bodies; smaller ones were dropped.`);
  }
  // Frame: CAD/printing files are Z-up (STEP/IGES/STL), glTF is Y-up. STL is unitless: treat large extents as millimetres.
  const zUp = format !== "glb";
  const all = new THREE.Box3();
  for (const mesh of raw) for (let i = 0; i < mesh.positions.length; i += 3) all.expandByPoint(new THREE.Vector3(mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]));
  const extent = all.getSize(new THREE.Vector3());
  const scale = format === "stl" && Math.max(extent.x, extent.y, extent.z) > 2 ? 0.001 : 1;
  if (scale !== 1) notes.push("STL units assumed to be millimetres.");
  if (zUp) notes.push("Converted Z-up CAD frame to the Y-up assembly frame.");
  const map = (x: number, y: number, z: number): Vec3 => (zUp ? [x * scale, z * scale, -y * scale] : [x * scale, y * scale, z * scale]);
  const mapped = raw.map((mesh) => { const out = new Float32Array(mesh.positions.length); for (let i = 0; i < out.length; i += 3) out.set(map(mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]), i); return out; });
  const total = new THREE.Box3();
  for (const positions of mapped) for (let i = 0; i < positions.length; i += 3) total.expandByPoint(new THREE.Vector3(positions[i], positions[i + 1], positions[i + 2]));
  const shift: Vec3 = [-(total.min.x + total.max.x) / 2, -total.min.y, -(total.min.z + total.max.z) / 2];
  const used = new Map<string, number>();
  const parts: CadPart[] = [], glbMeshes: GlbMesh[] = [];
  raw.forEach((mesh, i) => {
    const positions = mapped[i];
    const box = new THREE.Box3();
    for (let k = 0; k < positions.length; k += 3) { positions[k] += shift[0]; positions[k + 1] += shift[1]; positions[k + 2] += shift[2]; box.expandByPoint(new THREE.Vector3(positions[k], positions[k + 1], positions[k + 2])); }
    const c = box.getCenter(new THREE.Vector3());
    for (let k = 0; k < positions.length; k += 3) { positions[k] -= c.x; positions[k + 1] -= c.y; positions[k + 2] -= c.z; }
    const clean = mesh.name.replace(/[^\w .()#+-]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || `Part ${i + 1}`;
    const n = (used.get(clean) ?? 0) + 1; used.set(clean, n);
    const node = n === 1 ? clean : `${clean} (${n})`;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    if (mesh.indices) geometry.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
    geometry.computeVertexNormals();
    const normals = geometry.getAttribute("normal").array as Float32Array;
    const triangles = (mesh.indices?.length ?? positions.length / 3) / 3;
    const hex = mesh.color ? `#${mesh.color.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, "0")).join("")}` : undefined;
    glbMeshes.push({ name: node, positions, normals, indices: mesh.indices, color: mesh.color });
    parts.push({ node, name: clean, triangles, bbox: { min: box.min.toArray() as Vec3, max: box.max.toArray() as Vec3 }, position: c.toArray() as Vec3, quaternion: [0, 0, 0, 1], ...(hex ? { color: hex } : {}) });
  });
  return { parts, glb: writeGlb(glbMeshes), notes, format };
}
