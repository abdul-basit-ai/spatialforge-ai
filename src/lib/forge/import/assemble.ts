import * as THREE from "three";
import type { Quat, Vec3 } from "../types";

// Turns raw meshes from any CAD/mesh loader into one Forge assembly: metres, Y-up, centred on the largest part,
// one uniquely named part node per part. Pure three.js (no DOM), so it runs in the browser and in Node tests.

export type Units = "auto" | "m" | "cm" | "mm" | "in";
export type UpAxis = "y" | "z";

// One part as it comes out of a loader, in the source file's own frame and units.
export type RawPart = { name: string; path: string[]; color?: [number, number, number]; geometry: THREE.BufferGeometry };

// One source file worth of parts. `units` "m" means the loader already produced metres (STEP/IGES via OpenCascade).
export type RawFile = { file: string; format: string; parts: RawPart[]; units: Units; up: UpAxis };

// Parts list entry (assembly frame, metres). position = part origin (bbox centre); geometry in the GLB is local to it.
export type ImportedPart = {
  node: string; // object name inside the GLB (stable, sanitized, unique)
  name: string; // human-readable name
  path?: string[]; // sub-assembly path from the CAD tree
  file?: string; // source file name
  triangles: number;
  bbox: { min: Vec3; max: Vec3 };
  size: Vec3;
  position: Vec3;
  quaternion: Quat;
  color: string;
};

export type ImportedAssembly = {
  group: THREE.Group; // children = part nodes positioned at their assembled poses
  parts: ImportedPart[];
  baseNode: string; // the largest part (sits at the origin)
  bbox: { min: Vec3; max: Vec3 };
  triangles: number;
  scale: Record<string, number>; // file -> applied unit scale
  warnings: string[];
};

const UNIT_SCALE: Record<Exclude<Units, "auto">, number> = { m: 1, cm: 0.01, mm: 0.001, in: 0.0254 };
const STEEL = new THREE.Color("#8d9aa8");
const PALETTE = ["#9aa7b4", "#c9a36b", "#6fb7c9", "#b8bec6", "#d08a4c", "#7f8fa3", "#a7c3a0", "#c7b98f"];
const GENERIC = /^(solid|body|part|mesh|shape|compound|open cascade.*|product|unnamed|default|object|group|\d+)?[\s_\-#.]*\d*$/i;

const round = (n: number, digits = 6) => Math.round(n * 10 ** digits) / 10 ** digits;
const v3 = (v: THREE.Vector3): Vec3 => [round(v.x), round(v.y), round(v.z)];

// "L_BRACKET_ASSEMBLY_ASM" -> "L bracket assembly", "hex-nut_M3" -> "Hex nut M3"
export function humanizeName(raw: string): string {
  const clean = raw.replace(/\.(step|stp|iges|igs|stl|obj|glb|brep)$/i, "").replace(/[_\-]+/g, " ").replace(/\b(asm|prt|sldprt|sldasm)\b/gi, "").replace(/\s+/g, " ").trim().replace(/(.)\s(mesh|solid|body)$/i, "$1");
  if (!clean) return "Part";
  const words = clean.split(" ").map((word) => (/^[A-Z0-9]+$/.test(word) && word.length > 3 && !/\d/.test(word) ? word.toLowerCase() : word));
  const text = words.join(" ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// Node names must survive GLTFLoader's sanitizer and stay unique so Object3D.getObjectByName(node) finds them.
const nodeSlug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 48) || "part";

function partColor(color: [number, number, number] | undefined, index: number): THREE.Color {
  if (!color) return new THREE.Color(PALETTE[index % PALETTE.length]);
  // CAx colors are often pure RGB; pull them toward machined steel so the assembly reads as hardware.
  return new THREE.Color(color[0], color[1], color[2]).lerp(STEEL, 0.55);
}

// Picks a unit scale for files without units (STL/OBJ, and GLB that was exported in millimetres).
function autoScale(files: RawFile[]): Map<RawFile, number> {
  const result = new Map<RawFile, number>();
  const unitless = files.filter((file) => file.units === "auto");
  let largest = 0;
  for (const file of unitless) for (const part of file.parts) { part.geometry.computeBoundingBox(); const s = part.geometry.boundingBox!.getSize(new THREE.Vector3()); largest = Math.max(largest, s.x, s.y, s.z); }
  // Bench-top assemblies are well under 3 m; anything bigger is almost certainly millimetres.
  const guess = largest > 3 ? 0.001 : 1;
  for (const file of files) {
    if (file.units !== "auto") result.set(file, UNIT_SCALE[file.units]);
    else result.set(file, file.format === "glb" && largest <= 20 ? 1 : guess);
  }
  return result;
}

export function assemble(files: RawFile[], options: { units?: Units } = {}): ImportedAssembly {
  const warnings: string[] = [];
  const forced = options.units && options.units !== "auto" ? options.units : null;
  const scales = forced ? new Map(files.map((file) => [file, UNIT_SCALE[forced]] as const)) : autoScale(files);
  const zUp = new THREE.Matrix4().makeRotationX(-Math.PI / 2); // CAD Z-up -> Y-up: (x, y, z) -> (x, z, -y)

  type Prepared = { raw: RawPart; file: RawFile; geometry: THREE.BufferGeometry; box: THREE.Box3; volume: number; triangles: number };
  const prepared: Prepared[] = [];
  for (const file of files) {
    const scale = scales.get(file) ?? 1;
    const frame = new THREE.Matrix4().makeScale(scale, scale, scale);
    if (file.up === "z") frame.premultiply(zUp);
    for (const raw of file.parts) {
      const geometry = raw.geometry.clone().applyMatrix4(frame);
      if (!geometry.getAttribute("position") || geometry.getAttribute("position").count < 3) continue;
      if (!geometry.getAttribute("normal")) geometry.computeVertexNormals();
      geometry.computeBoundingBox();
      const box = geometry.boundingBox!.clone();
      const size = box.getSize(new THREE.Vector3());
      const triangles = (geometry.index ? geometry.index.count : geometry.getAttribute("position").count) / 3;
      prepared.push({ raw, file, geometry, box, volume: Math.max(size.x, 1e-6) * Math.max(size.y, 1e-6) * Math.max(size.z, 1e-6), triangles });
    }
  }
  if (!prepared.length) throw new Error("No solid geometry found in the CAD files.");

  const base = prepared.reduce((best, item) => (item.volume > best.volume || (item.volume === best.volume && item.triangles > best.triangles) ? item : best));
  const offset = base.box.getCenter(new THREE.Vector3()).negate();

  const group = new THREE.Group();
  group.name = "forge_assembly";
  const parts: ImportedPart[] = [];
  const used = new Map<string, number>();
  const nameCount = new Map<string, number>();
  const total = new THREE.Box3();
  let baseNode = "";

  prepared.forEach((item, index) => {
    const { raw, geometry } = item;
    const leaf = raw.name && !GENERIC.test(raw.name.trim()) ? raw.name : [...raw.path].reverse().find((name) => name && !GENERIC.test(name.trim())) ?? item.file.file;
    const human = humanizeName(leaf);
    const count = (nameCount.get(human) ?? 0) + 1; nameCount.set(human, count);
    const slug = nodeSlug(human);
    const seen = (used.get(slug) ?? 0) + 1; used.set(slug, seen);
    const node = seen === 1 ? slug : `${slug}_${seen}`;
    const box = item.box.clone().translate(offset);
    const center = box.getCenter(new THREE.Vector3());
    geometry.translate(-(center.x - offset.x), -(center.y - offset.y), -(center.z - offset.z)); // local to the part origin
    geometry.computeBoundingBox(); geometry.computeBoundingSphere();
    const color = partColor(raw.color, index);
    const material = new THREE.MeshStandardMaterial({ color, metalness: 0.55, roughness: 0.38, name: `${node}_mat` });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `${node}_mesh`;
    const holder = new THREE.Group();
    holder.name = node;
    holder.position.copy(center);
    holder.add(mesh);
    const entry: ImportedPart = { node, name: count > 1 ? `${human} ${count}` : human, path: raw.path.filter(Boolean), file: item.file.file, triangles: Math.round(item.triangles), bbox: { min: v3(box.min), max: v3(box.max) }, size: v3(box.getSize(new THREE.Vector3())), position: v3(center), quaternion: [0, 0, 0, 1], color: `#${color.getHexString()}` };
    holder.userData = { forgePart: true, name: entry.name, path: entry.path, position: entry.position, bbox: entry.bbox };
    group.add(holder);
    parts.push(entry);
    total.union(box);
    if (item === base) baseNode = node;
  });

  // Rename "Nut" to "Nut 1" when "Nut 2" exists, so every instance is distinguishable in the editor.
  for (const part of parts) if (!/\s\d+$/.test(part.name) && (nameCount.get(part.name) ?? 0) > 1) part.name = `${part.name} 1`;
  for (const holder of group.children) holder.userData.name = parts.find((part) => part.node === holder.name)?.name;

  const extent = total.getSize(new THREE.Vector3());
  const largest = Math.max(extent.x, extent.y, extent.z);
  if (largest > 5) warnings.push(`The assembly is ${largest.toFixed(1)} m across; if it should be smaller, set units to mm.`);
  if (largest < 0.002) warnings.push(`The assembly is only ${(largest * 1000).toFixed(2)} mm across; if it should be larger, set units to m or inches.`);
  const triangles = parts.reduce((sum, part) => sum + part.triangles, 0);
  if (triangles > 1_500_000) warnings.push(`${triangles.toLocaleString()} triangles is heavy for AR; consider a coarser export.`);
  return { group, parts, baseNode, bbox: { min: v3(total.min), max: v3(total.max) }, triangles, scale: Object.fromEntries(files.map((file) => [file.file, scales.get(file) ?? 1])), warnings };
}
