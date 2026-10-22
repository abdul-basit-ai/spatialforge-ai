import * as THREE from "three";
import type { ForgePart, ForgeScenario } from "../types";

// Coherence checks for AI-designed primitive assemblies (advisory, fed to the repair pass; never blocks publishing).
// Mirrors primitiveGeometry() conventions in three-parts.ts: round parts run along local Y, rings lie in local XY.

const ROUND = new Set(["cylinder", "shaft", "leadscrew", "cap", "motor", "tube", "bearing", "coupling", "pulley", "hex", "nut", "bolt", "screw"]);
const INNER = new Set(["shaft", "leadscrew", "bolt", "screw", "cylinder", "spring", "cable", "pin"]);
const HOLED = new Set(["tube", "bearing", "coupling", "pulley", "gear", "nut", "washer", "torus", "housing", "carriage", "cap", "motor", "bracket", "plate", "rail", "spring", "box"]);

export function localHalfExtents(shape: string, p: Record<string, number>): THREE.Vector3 {
  const r = p.radius ?? (shape === "bolt" || shape === "screw" ? 0.003 : 0.02), len = p.length ?? p.height ?? 0.05;
  if (ROUND.has(shape)) return new THREE.Vector3(r, len / 2, r);
  if (shape === "gear") return new THREE.Vector3(r, (p.thickness ?? 0.01) / 2, r);
  if (shape === "torus" || shape === "washer") { const t = p.tube ?? r * 0.25; return new THREE.Vector3(r + t, r + t, t); }
  if (shape === "spring") return new THREE.Vector3(r * 1.3, r * 1.3, r * 0.5);
  return new THREE.Vector3((p.width ?? 0.05) / 2, (p.height ?? 0.05) / 2, (p.depth ?? 0.05) / 2);
}

export function partBox(part: ForgePart): THREE.Box3 | null {
  if (part.geometry.kind !== "primitive") return null;
  const half = localHalfExtents(part.geometry.shape, part.geometry.params);
  const matrix = new THREE.Matrix4().compose(new THREE.Vector3(...part.assembled.position), new THREE.Quaternion(...part.assembled.quaternion), new THREE.Vector3(1, 1, 1));
  return new THREE.Box3(half.clone().negate(), half).applyMatrix4(matrix);
}

const vol = (b: THREE.Box3) => { const s = b.getSize(new THREE.Vector3()); return Math.max(1e-12, s.x * s.y * s.z); };

export function geometryWarnings(scenario: ForgeScenario): string[] {
  const warnings: string[] = [];
  const boxes = scenario.parts.map((part) => ({ part, box: partBox(part) })).filter((entry): entry is { part: ForgePart; box: THREE.Box3 } => Boolean(entry.box));
  if (!boxes.length) return warnings;
  const all = new THREE.Box3();
  for (const { box } of boxes) all.union(box);
  const size = all.getSize(new THREE.Vector3());
  const extent = Math.max(size.x, size.y, size.z);
  if (extent > 2) warnings.push(`The assembly spans ${extent.toFixed(2)} m; check units (params and positions are metres).`);
  if (extent < 0.01) warnings.push(`The assembly spans only ${(extent * 1000).toFixed(1)} mm; check units (metres).`);
  if (all.min.y < -0.02) warnings.push(`Parts extend ${(-all.min.y * 1000).toFixed(0)} mm below the base plane y=0.`);
  for (const { part, box } of boxes) {
    if (scenario.baseParts.includes(part.id)) continue;
    const grown = box.clone().expandByScalar(0.003);
    if (!boxes.some((other) => other.part !== part && grown.intersectsBox(other.box))) warnings.push(`${part.name} (${part.id}) floats: it touches no other part at its assembled pose.`);
  }
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i], b = boxes[j];
    if (!a.box.intersectsBox(b.box)) continue;
    const overlap = vol(a.box.clone().intersect(b.box)) / Math.min(vol(a.box), vol(b.box));
    if (overlap < 0.4) continue;
    const sa = a.part.geometry.kind === "primitive" ? a.part.geometry.shape : "", sb = b.part.geometry.kind === "primitive" ? b.part.geometry.shape : "";
    const nested = (INNER.has(sa) && HOLED.has(sb)) || (INNER.has(sb) && HOLED.has(sa)) || sa === "housing" || sb === "housing";
    if (!nested) warnings.push(`${a.part.name} and ${b.part.name} overlap by ${Math.round(overlap * 100)}% of the smaller part; move one so they sit against each other.`);
  }
  return warnings.slice(0, 14);
}
