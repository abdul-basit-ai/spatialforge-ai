import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { ForgePart, PartCategory, Transform } from "./types";

// Builds Three.js objects for Forge parts. Shared by the 3D trainer, AR modes, and the studio editor.
// Primitive params are metres; meshes come from glTF assets served at /api/forge/assets/<id>.
// Conventions for primitives: every shape is centred on its bounding-box centre. Axial parts (shafts, bolts, gears,
// bearings, motors, springs, sensors, caps, pulleys, leadscrews) run along +Y (bolt heads, motor shafts and caps point +Y).
// Rails and carriages run along X; belts loop in the XZ plane; plates, PCBs and housings lie flat in XZ.

const gltfCache = new Map<string, Promise<THREE.Group>>();

export function loadAsset(assetId: string): Promise<THREE.Group> {
  let cached = gltfCache.get(assetId);
  if (!cached) {
    cached = new GLTFLoader().loadAsync(`/api/forge/assets/${assetId}`).then((gltf) => gltf.scene);
    cached.catch(() => gltfCache.delete(assetId));
    gltfCache.set(assetId, cached);
  }
  return cached;
}

// ---- materials -------------------------------------------------------------------------------------------------

export type Finish = "main" | "steel" | "dark" | "rubber" | "plastic" | "nylon" | "gold" | "pcb" | "led" | "brass";
type MaterialSpec = { color: string; metalness: number; roughness: number; emissive?: string; emissiveIntensity?: number };

const CATEGORY_FINISH: Record<PartCategory, MaterialSpec> = {
  structural: { color: "#a7b1bc", metalness: 0.85, roughness: 0.36 },
  fastener: { color: "#cfd5dc", metalness: 1, roughness: 0.27 },
  seal: { color: "#1c1e21", metalness: 0, roughness: 0.82 },
  bearing: { color: "#e1e5ea", metalness: 1, roughness: 0.17 },
  drive: { color: "#b9c2cb", metalness: 0.92, roughness: 0.3 },
  motor: { color: "#24292f", metalness: 0.55, roughness: 0.42 },
  sensor: { color: "#2b3541", metalness: 0.25, roughness: 0.48 },
  electronics: { color: "#1c6a45", metalness: 0.1, roughness: 0.62 },
  connector: { color: "#e7e1d1", metalness: 0, roughness: 0.55 },
  cable: { color: "#1f2328", metalness: 0, roughness: 0.68 },
  tool: { color: "#e8891c", metalness: 0.2, roughness: 0.5 },
  other: { color: "#8d98a5", metalness: 0.5, roughness: 0.45 },
};

const FINISH: Record<Exclude<Finish, "main">, MaterialSpec> = {
  steel: { color: "#cdd3da", metalness: 1, roughness: 0.25 },
  dark: { color: "#0d1014", metalness: 0.4, roughness: 0.6 },
  rubber: { color: "#17191c", metalness: 0, roughness: 0.88 },
  plastic: { color: "#22262b", metalness: 0, roughness: 0.5 },
  nylon: { color: "#e9e3d3", metalness: 0, roughness: 0.55 },
  gold: { color: "#d9a441", metalness: 1, roughness: 0.3 },
  pcb: { color: "#1c6a45", metalness: 0.1, roughness: 0.62 },
  led: { color: "#ffb547", metalness: 0, roughness: 0.3, emissive: "#ffb547", emissiveIntensity: 1.4 },
  brass: { color: "#c9a45a", metalness: 1, roughness: 0.32 },
};

export function partMaterial(finish: Finish, category: PartCategory = "other", color?: string): THREE.MeshStandardMaterial {
  const spec = finish === "main" ? { ...CATEGORY_FINISH[category] ?? CATEGORY_FINISH.other, ...(color ? { color } : {}) } : FINISH[finish];
  const material = new THREE.MeshStandardMaterial({ color: spec.color, metalness: spec.metalness, roughness: spec.roughness, emissive: spec.emissive ?? "#000000", emissiveIntensity: spec.emissiveIntensity ?? 1 });
  material.userData.baseEmissive = material.emissive.clone();
  material.userData.baseEmissiveIntensity = material.emissiveIntensity;
  return material;
}

// ---- geometry helpers ------------------------------------------------------------------------------------------

type Piece = { geometry: THREE.BufferGeometry; finish: Finish };
const V2 = (x: number, y: number) => new THREE.Vector2(x, y);
const num = (p: Record<string, number>, key: string, fallback: number) => (Number.isFinite(p[key]) && p[key] > 0 ? p[key] : fallback);

function lathe(points: Array<[number, number]>, segments = 32) {
  return new THREE.LatheGeometry(points.map(([r, y]) => V2(Math.max(0, r), y)), segments);
}

// Annulus (ring) along Y from y0 to y1.
function ring(outer: number, inner: number, y0: number, y1: number, segments = 32) {
  if (inner <= 0) return lathe([[0, y0], [outer, y0], [outer, y1], [0, y1]], segments);
  return lathe([[inner, y0], [outer, y0], [outer, y1], [inner, y1], [inner, y0]], segments);
}

function cylinder(radius: number, y0: number, y1: number, segments = 32) {
  const g = new THREE.CylinderGeometry(radius, radius, Math.abs(y1 - y0), segments);
  g.translate(0, (y0 + y1) / 2, 0);
  return g;
}

function box(w: number, h: number, d: number, x = 0, y = 0, z = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return g;
}

// Extrudes a 2D shape (XY) along +Y by `depth`, centred on y = 0.
function extrudeY(shape: THREE.Shape, depth: number, curveSegments = 12) {
  const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments });
  g.translate(0, 0, -depth / 2);
  g.rotateX(-Math.PI / 2);
  return g;
}

// Extrudes a 2D profile (x = Z, y = Y) along X by `length`, centred.
function extrudeX(shape: THREE.Shape, length: number) {
  const g = new THREE.ExtrudeGeometry(shape, { depth: length, bevelEnabled: false, curveSegments: 8 });
  g.translate(0, 0, -length / 2);
  g.rotateY(Math.PI / 2);
  return g;
}

function circlePath(radius: number, x = 0, y = 0) {
  const path = new THREE.Path();
  path.absarc(x, y, radius, 0, Math.PI * 2, true);
  return path;
}

function polygonShape(sides: number, radius: number, rotation = 0) {
  const shape = new THREE.Shape();
  for (let i = 0; i <= sides; i++) {
    const a = rotation + (i / sides) * Math.PI * 2;
    if (i === 0) shape.moveTo(Math.cos(a) * radius, Math.sin(a) * radius); else shape.lineTo(Math.cos(a) * radius, Math.sin(a) * radius);
  }
  return shape;
}

// Threaded rod profile (radius along Y) as lathe points, chamfered at both ends.
function threadProfile(radius: number, y0: number, y1: number, pitch: number, depth = 0.14, trapezoid = false): Array<[number, number]> {
  const points: Array<[number, number]> = [[0, y0], [radius * (1 - depth), y0]];
  const inner = radius * (1 - depth);
  const count = Math.min(400, Math.max(2, Math.floor((y1 - y0 - pitch) / pitch)));
  const step = (y1 - y0 - pitch) / count;
  for (let i = 0; i < count; i++) {
    const y = y0 + pitch / 2 + i * step;
    if (trapezoid) points.push([inner, y], [radius, y + step * 0.25], [radius, y + step * 0.5], [inner, y + step * 0.75]);
    else points.push([inner, y], [radius, y + step * 0.5]);
  }
  points.push([inner, y1 - pitch / 2], [radius * (1 - depth), y1], [0, y1]);
  return points;
}

// Spur gear outline with trapezoidal teeth, a bore and lightening holes.
function gearShape(pitchRadius: number, teeth: number, bore: number, holes = true) {
  const n = Math.max(6, Math.round(teeth));
  const module = (2 * pitchRadius) / n;
  const ra = pitchRadius + module, rf = Math.max(pitchRadius - 1.25 * module, pitchRadius * 0.5);
  const p = (Math.PI * 2) / n;
  const shape = new THREE.Shape();
  const at = (r: number, a: number) => [Math.cos(a) * r, Math.sin(a) * r] as const;
  for (let i = 0; i < n; i++) {
    const a = i * p;
    const pts = [at(rf, a - p * 0.5), at(rf, a - p * 0.3), at(pitchRadius, a - p * 0.22), at(ra, a - p * 0.13), at(ra, a + p * 0.13), at(pitchRadius, a + p * 0.22), at(rf, a + p * 0.3)];
    pts.forEach(([x, y], j) => (i === 0 && j === 0 ? shape.moveTo(x, y) : shape.lineTo(x, y)));
  }
  shape.closePath();
  if (bore > 0) shape.holes.push(circlePath(bore));
  if (holes && rf > bore * 3.2 && rf > 0.018) {
    const mid = (rf + bore) / 2, hr = (rf - bore) * 0.22;
    for (let i = 0; i < 5; i++) { const a = (i / 5) * Math.PI * 2; shape.holes.push(circlePath(hr, Math.cos(a) * mid, Math.sin(a) * mid)); }
  }
  return shape;
}

function stadiumShape(halfLength: number, radius: number) {
  const s = new THREE.Shape();
  s.moveTo(-halfLength, -radius);
  s.lineTo(halfLength, -radius);
  s.absarc(halfLength, 0, radius, -Math.PI / 2, Math.PI / 2, false);
  s.lineTo(-halfLength, radius);
  s.absarc(-halfLength, 0, radius, Math.PI / 2, (Math.PI * 3) / 2, false);
  return s;
}

function stadiumPath(halfLength: number, radius: number) {
  const s = new THREE.Path();
  s.moveTo(-halfLength, -radius);
  s.absarc(-halfLength, 0, radius, (Math.PI * 3) / 2, Math.PI / 2, true);
  s.lineTo(halfLength, radius);
  s.absarc(halfLength, 0, radius, Math.PI / 2, -Math.PI / 2, true);
  s.lineTo(-halfLength, -radius);
  return s;
}

class HelixCurve extends THREE.Curve<THREE.Vector3> {
  constructor(private radius: number, private length: number, private turns: number) { super(); }
  getPoint(t: number, target = new THREE.Vector3()) {
    const a = t * this.turns * Math.PI * 2;
    return target.set(Math.cos(a) * this.radius, -this.length / 2 + t * this.length, Math.sin(a) * this.radius);
  }
}

// Short cylinder oriented along `direction`, centred at `at`.
function orientedCylinder(radius: number, length: number, at: THREE.Vector3, direction: THREE.Vector3, segments = 16) {
  const g = new THREE.CylinderGeometry(radius, radius, length, segments);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.clone().normalize()));
  g.translate(at.x, at.y, at.z);
  return g;
}

// Deterministic pseudo-random sequence from a seed (stable PCB component layouts).
function seeded(seed: number) {
  let s = Math.abs(Math.floor(seed * 9973)) % 2147483647 || 7;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

// ---- shapes ----------------------------------------------------------------------------------------------------

function shapePieces(shape: string, p: Record<string, number>): Piece[] {
  const r = num(p, "radius", 0.02);
  const len = num(p, "length", num(p, "height", 0.05));
  switch (shape) {
    case "box": {
      const w = num(p, "width", 0.05), h = num(p, "height", 0.05), d = num(p, "depth", 0.05);
      const g = new THREE.BoxGeometry(w, h, d);
      const bevel = Math.min(w, h, d) * 0.04;
      return [{ geometry: g, finish: "main" }, { geometry: box(w - bevel * 2, bevel, d - bevel * 2, 0, h / 2, 0), finish: "main" }];
    }
    case "plate": {
      const w = num(p, "width", 0.12), d = num(p, "depth", 0.08), t = num(p, "thickness", num(p, "height", 0.006));
      const s = new THREE.Shape();
      const c = Math.min(w, d) * 0.06;
      s.moveTo(-w / 2 + c, -d / 2); s.lineTo(w / 2 - c, -d / 2); s.lineTo(w / 2, -d / 2 + c); s.lineTo(w / 2, d / 2 - c); s.lineTo(w / 2 - c, d / 2); s.lineTo(-w / 2 + c, d / 2); s.lineTo(-w / 2, d / 2 - c); s.lineTo(-w / 2, -d / 2 + c); s.closePath();
      const hr = Math.min(w, d) * 0.035, inset = Math.min(w, d) * 0.1;
      for (const [x, y] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) s.holes.push(circlePath(hr, x * (w / 2 - inset), y * (d / 2 - inset)));
      return [{ geometry: extrudeY(s, t, 16), finish: "main" }];
    }
    case "bracket": {
      const w = num(p, "width", 0.05), h = num(p, "height", 0.05), d = num(p, "depth", 0.04), t = num(p, "thickness", Math.min(w, h) * 0.12);
      const s = new THREE.Shape();
      s.moveTo(0, 0); s.lineTo(w, 0); s.lineTo(w, t); s.lineTo(t, t); s.lineTo(t, h); s.lineTo(0, h); s.closePath();
      const body = new THREE.ExtrudeGeometry(s, { depth: d, bevelEnabled: false });
      body.translate(-w / 2, -h / 2, -d / 2);
      const gusset = new THREE.Shape();
      gusset.moveTo(t, t); gusset.lineTo(t + (w - t) * 0.6, t); gusset.lineTo(t, t + (h - t) * 0.6); gusset.closePath();
      const gg = new THREE.ExtrudeGeometry(gusset, { depth: t * 0.8, bevelEnabled: false });
      gg.translate(-w / 2, -h / 2, -t * 0.4);
      const hr = Math.min(d, w) * 0.09;
      const holes = [
        orientedCylinder(hr, t * 0.15, new THREE.Vector3(-w / 2 + t + (w - t) * 0.72, -h / 2 + t + 0.00005, -d * 0.28), new THREE.Vector3(0, 1, 0)),
        orientedCylinder(hr, t * 0.15, new THREE.Vector3(-w / 2 + t + (w - t) * 0.72, -h / 2 + t + 0.00005, d * 0.28), new THREE.Vector3(0, 1, 0)),
        orientedCylinder(hr, t * 0.15, new THREE.Vector3(-w / 2 + t + 0.00005, -h / 2 + t + (h - t) * 0.72, -d * 0.28), new THREE.Vector3(1, 0, 0)),
        orientedCylinder(hr, t * 0.15, new THREE.Vector3(-w / 2 + t + 0.00005, -h / 2 + t + (h - t) * 0.72, d * 0.28), new THREE.Vector3(1, 0, 0)),
      ];
      return [{ geometry: body, finish: "main" }, { geometry: gg, finish: "main" }, ...holes.map((geometry) => ({ geometry, finish: "dark" as const }))];
    }
    case "cylinder":
      return [{ geometry: lathe([[0, -len / 2], [r * 0.96, -len / 2], [r, -len / 2 + r * 0.04], [r, len / 2 - r * 0.04], [r * 0.96, len / 2], [0, len / 2]], 40), finish: "main" }];
    case "shaft": {
      const sr = num(p, "radius", 0.004), c = Math.min(sr * 0.15, len * 0.05);
      const step = Math.min(len * 0.12, sr * 3);
      return [
        { geometry: lathe([[0, -len / 2], [sr * 0.9 - c, -len / 2], [sr * 0.9, -len / 2 + c], [sr * 0.9, -len / 2 + step], [sr, -len / 2 + step + c], [sr, len / 2 - c], [sr - c, len / 2], [0, len / 2]], 28), finish: "steel" },
        { geometry: box(sr * 0.5, len * 0.25, sr * 0.3, 0, len * 0.2, sr * 0.88), finish: "dark" },
      ];
    }
    case "tube": {
      const inner = num(p, "innerRadius", r * 0.82);
      return [{ geometry: ring(r, Math.min(inner, r * 0.98), -len / 2, len / 2, 40), finish: "main" }];
    }
    case "hex": {
      const g = extrudeY(polygonShape(6, r, Math.PI / 6), len);
      return [{ geometry: g, finish: "main" }];
    }
    case "torus":
      return [{ geometry: new THREE.TorusGeometry(r, num(p, "tube", r * 0.18), 14, 40).rotateX(Math.PI / 2), finish: "main" }];
    case "washer": {
      const inner = num(p, "innerRadius", r * 0.52), t = num(p, "thickness", num(p, "length", r * 0.16));
      return [{ geometry: ring(r, Math.min(inner, r * 0.95), -t / 2, t / 2, 36), finish: "main" }];
    }
    case "nut": {
      const t = num(p, "thickness", num(p, "length", r * 0.9)), inner = num(p, "innerRadius", r * 0.5);
      const s = polygonShape(6, r, Math.PI / 6);
      s.holes.push(circlePath(inner));
      return [{ geometry: extrudeY(s, t), finish: "main" }, { geometry: ring(inner * 1.02, inner * 0.82, -t / 2 + t * 0.02, t / 2 - t * 0.02, 20), finish: "dark" }];
    }
    case "bolt": case "screw": {
      const sr = num(p, "radius", 0.003), L = num(p, "length", 0.02);
      const hh = num(p, "headHeight", sr * (shape === "screw" ? 2 : 1.4)), hr = num(p, "headRadius", sr * (shape === "screw" ? 1.6 : 1.85));
      const total = L + hh, y0 = -total / 2, ys = y0 + L;
      const pitch = num(p, "pitch", Math.max(sr * 0.33, 0.0003));
      const pieces: Piece[] = [{ geometry: lathe(threadProfile(sr, y0, ys + sr * 0.1, pitch), 18), finish: "main" }];
      if (shape === "bolt") {
        pieces.push({ geometry: extrudeY(polygonShape(6, hr, Math.PI / 6), hh).translate(0, ys + hh / 2, 0), finish: "main" });
        pieces.push({ geometry: ring(hr * 0.9, 0, ys, ys + hh * 0.08, 28), finish: "main" });
      } else {
        const c = hh * 0.1;
        pieces.push({ geometry: lathe([[0, ys], [hr, ys], [hr, ys + hh - c], [hr - c, ys + hh], [0, ys + hh]], 32), finish: "main" });
        pieces.push({ geometry: extrudeY(polygonShape(6, hr * 0.48, 0), hh * 0.04).translate(0, ys + hh + hh * 0.01, 0), finish: "dark" });
      }
      return pieces;
    }
    case "spring": {
      const wire = num(p, "wire", r * 0.12), turns = Math.max(2, num(p, "turns", 7));
      const geometry = new THREE.TubeGeometry(new HelixCurve(r, len - wire * 2, turns), Math.round(turns * 22), wire, 8, false);
      return [{ geometry, finish: "main" }, { geometry: new THREE.TorusGeometry(r, wire, 6, 28).rotateX(Math.PI / 2).translate(0, -len / 2 + wire, 0), finish: "main" }, { geometry: new THREE.TorusGeometry(r, wire, 6, 28).rotateX(Math.PI / 2).translate(0, len / 2 - wire, 0), finish: "main" }];
    }
    case "gear": {
      const t = num(p, "thickness", num(p, "length", r * 0.3)), teeth = num(p, "teeth", 24), bore = num(p, "bore", r * 0.18);
      const pieces: Piece[] = [{ geometry: extrudeY(gearShape(r, teeth, bore), t, 8), finish: "main" }];
      pieces.push({ geometry: ring(bore * 2.1, bore, -t / 2 - t * 0.25, t / 2 + t * 0.25, 28), finish: "main" });
      pieces.push({ geometry: box(bore * 0.5, t * 1.5, bore * 0.35, 0, 0, bore * 1.05), finish: "dark" });
      return pieces;
    }
    case "pulley": {
      const w = num(p, "length", num(p, "width", r * 0.8)), teeth = num(p, "teeth", 20), bore = num(p, "bore", r * 0.3);
      return [
        { geometry: extrudeY(gearShape(r * 0.92, teeth, bore, false), w * 0.7, 6), finish: "main" },
        { geometry: ring(r * 1.18, bore, w * 0.35, w * 0.42, 36), finish: "main" },
        { geometry: ring(r * 1.18, bore, -w * 0.42, -w * 0.35, 36), finish: "main" },
        { geometry: ring(r * 0.8, bore, -w * 0.42 - w * 0.55, -w * 0.42, 32), finish: "main" },
        { geometry: orientedCylinder(bore * 0.5, r * 0.2, new THREE.Vector3(0, -w * 0.7, r * 0.75), new THREE.Vector3(0, 0, 1), 10), finish: "dark" },
      ];
    }
    case "belt": {
      const half = num(p, "length", 0.1) / 2, pr = num(p, "radius", 0.008), w = num(p, "width", 0.006), t = num(p, "thickness", 0.0015);
      const s = stadiumShape(half, pr + t);
      s.holes.push(stadiumPath(half, pr));
      return [{ geometry: extrudeY(s, w, 20), finish: "rubber" }];
    }
    case "bearing": {
      const inner = num(p, "innerRadius", r * 0.45), w = num(p, "length", num(p, "width", r * 0.5));
      const ro = r, ri1 = r - (r - inner) * 0.24, ri2 = inner + (r - inner) * 0.24, c = w * 0.06;
      return [
        { geometry: lathe([[ri1, -w / 2], [ro - c, -w / 2], [ro, -w / 2 + c], [ro, w / 2 - c], [ro - c, w / 2], [ri1, w / 2], [ri1, -w / 2]], 40), finish: "main" },
        { geometry: lathe([[inner, -w / 2], [ri2, -w / 2], [ri2, w / 2], [inner + c, w / 2], [inner, w / 2 - c], [inner, -w / 2]], 32), finish: "main" },
        { geometry: ring(ri1, ri2, -w * 0.44, w * 0.44, 40), finish: "rubber" },
      ];
    }
    case "coupling": {
      const bore = num(p, "bore", r * 0.35), pieces: Piece[] = [];
      const pts: Array<[number, number]> = [[bore, -len / 2], [r, -len / 2]];
      const grooves = 4;
      for (let i = 0; i < grooves; i++) {
        const y = -len * 0.25 + (i / (grooves - 1)) * len * 0.5;
        pts.push([r, y - len * 0.03], [r * 0.78, y - len * 0.025], [r * 0.78, y + len * 0.025], [r, y + len * 0.03]);
      }
      pts.push([r, len / 2], [bore, len / 2], [bore, -len / 2]);
      pieces.push({ geometry: lathe(pts, 36), finish: "main" });
      for (const y of [-len * 0.4, len * 0.4]) pieces.push({ geometry: orientedCylinder(r * 0.16, r * 0.1, new THREE.Vector3(0, y, r * 0.97), new THREE.Vector3(0, 0, 1), 12), finish: "dark" });
      return pieces;
    }
    case "rail": {
      const L = num(p, "length", 0.3), w = num(p, "width", 0.015), h = num(p, "height", w * 0.9), g = w * 0.12;
      const s = new THREE.Shape();
      s.moveTo(-w / 2, 0); s.lineTo(w / 2, 0); s.lineTo(w / 2, h * 0.52); s.lineTo(w / 2 - g, h * 0.6); s.lineTo(w / 2 - g, h * 0.74); s.lineTo(w / 2, h * 0.82); s.lineTo(w / 2, h);
      s.lineTo(-w / 2, h); s.lineTo(-w / 2, h * 0.82); s.lineTo(-w / 2 + g, h * 0.74); s.lineTo(-w / 2 + g, h * 0.6); s.lineTo(-w / 2, h * 0.52); s.closePath();
      const body = extrudeX(s, L).translate(0, -h / 2, 0);
      const spacing = Math.max(0.02, num(p, "pitch", 0.06)), count = Math.min(24, Math.max(1, Math.floor(L / spacing)));
      const holes = Array.from({ length: count }, (_, i) => cylinder(w * 0.22, h / 2 - 0.0002, h / 2 + 0.00008, 14).translate(-L / 2 + (L - (count - 1) * spacing) / 2 + i * spacing, 0, 0));
      return [{ geometry: body, finish: "main" }, { geometry: mergeAll(holes), finish: "dark" }];
    }
    case "carriage": {
      const L = num(p, "length", 0.04), w = num(p, "width", 0.034), h = num(p, "height", 0.012), rw = num(p, "railWidth", w * 0.45), cut = h * 0.45;
      const s = new THREE.Shape();
      s.moveTo(-w / 2, 0); s.lineTo(-rw / 2, 0); s.lineTo(-rw / 2, cut); s.lineTo(rw / 2, cut); s.lineTo(rw / 2, 0); s.lineTo(w / 2, 0); s.lineTo(w / 2, h); s.lineTo(-w / 2, h); s.closePath();
      const body = extrudeX(s, L * 0.8).translate(0, -h / 2, 0);
      const caps = [extrudeX(s, L * 0.08).translate(-L * 0.44, -h / 2, 0), extrudeX(s, L * 0.08).translate(L * 0.44, -h / 2, 0)];
      const holes = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, z]) => cylinder(w * 0.07, h / 2 - 0.0002, h / 2 + 0.00008, 14).translate(x * L * 0.26, 0, z * w * 0.32));
      const nipple = orientedCylinder(h * 0.12, L * 0.08, new THREE.Vector3(L * 0.52, 0, 0), new THREE.Vector3(1, 0, 0), 10);
      return [{ geometry: body, finish: "main" }, { geometry: mergeAll(caps), finish: "plastic" }, { geometry: mergeAll(holes), finish: "dark" }, { geometry: nipple, finish: "brass" }];
    }
    case "leadscrew": {
      const sr = num(p, "radius", 0.004), L = num(p, "length", 0.2), pitch = num(p, "pitch", Math.max(sr * 0.5, 0.001));
      const plain = Math.min(L * 0.08, sr * 4);
      return [
        { geometry: lathe(threadProfile(sr, -L / 2 + plain, L / 2 - plain, pitch, 0.2, true), 20), finish: "main" },
        { geometry: lathe([[0, -L / 2], [sr * 0.58, -L / 2], [sr * 0.62, -L / 2 + sr * 0.05], [sr * 0.62, -L / 2 + plain + 0.0001], [0, -L / 2 + plain + 0.0001]], 20), finish: "steel" },
        { geometry: lathe([[0, L / 2 - plain - 0.0001], [sr * 0.62, L / 2 - plain - 0.0001], [sr * 0.62, L / 2 - sr * 0.05], [sr * 0.58, L / 2], [0, L / 2]], 20), finish: "steel" },
      ];
    }
    case "motor": {
      const s = num(p, "width", num(p, "size", 0.042)), L = num(p, "length", 0.04), sr = num(p, "shaftRadius", s * 0.06), sl = num(p, "shaftLength", s * 0.52);
      const oct = new THREE.Shape(), c = s * 0.12, hs = s / 2;
      oct.moveTo(-hs + c, -hs); oct.lineTo(hs - c, -hs); oct.lineTo(hs, -hs + c); oct.lineTo(hs, hs - c); oct.lineTo(hs - c, hs); oct.lineTo(-hs + c, hs); oct.lineTo(-hs, hs - c); oct.lineTo(-hs, -hs + c); oct.closePath();
      const bossH = s * 0.05, total = L + bossH + sl, y0 = -total / 2, yTop = y0 + L;
      const cap = L * 0.2;
      const pieces: Piece[] = [
        { geometry: extrudeY(oct, cap).translate(0, y0 + cap / 2, 0), finish: "main" },
        { geometry: extrudeY(polygonShape(8, hs * 1.03, Math.PI / 8), L - cap * 2).translate(0, y0 + L / 2, 0), finish: "dark" },
        { geometry: extrudeY(oct, cap).translate(0, yTop - cap / 2, 0), finish: "main" },
        { geometry: cylinder(s * 0.26, yTop, yTop + bossH, 36), finish: "main" },
        { geometry: lathe([[0, yTop + bossH], [sr, yTop + bossH], [sr, yTop + bossH + sl - sr * 0.2], [sr * 0.8, yTop + bossH + sl], [0, yTop + bossH + sl]], 20), finish: "steel" },
        { geometry: box(sr * 0.5, sl * 0.7, sr * 0.8, sr * 0.85, yTop + bossH + sl * 0.62, 0), finish: "dark" },
        { geometry: mergeAll([[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, z]) => cylinder(s * 0.04, yTop - 0.0002, yTop + 0.0001, 12).translate(x * s * 0.39, 0, z * s * 0.39))), finish: "dark" },
        { geometry: box(s * 0.36, cap * 0.9, s * 0.12, 0, y0 + cap * 0.55, -hs - s * 0.05), finish: "nylon" },
      ];
      return pieces;
    }
    case "sensor": {
      const sr = num(p, "radius", 0.006), L = num(p, "length", 0.045);
      const face = L * 0.08, led = L * 0.06;
      return [
        { geometry: lathe(threadProfile(sr, -L / 2 + face, L / 2 - led, Math.max(sr * 0.16, 0.0004), 0.08), 24), finish: "steel" },
        { geometry: lathe([[0, -L / 2], [sr * 0.95, -L / 2], [sr * 0.98, -L / 2 + face], [0, -L / 2 + face]], 24), finish: "main" },
        { geometry: ring(sr * 0.86, 0, L / 2 - led, L / 2, 24), finish: "led" },
        { geometry: cylinder(sr * 0.35, L / 2, L / 2 + L * 0.18, 12), finish: "plastic" },
        { geometry: extrudeY((() => { const h = polygonShape(6, sr * 1.65, Math.PI / 6); h.holes.push(circlePath(sr)); return h; })(), sr * 0.5).translate(0, L * 0.18, 0), finish: "steel" },
      ];
    }
    case "pcb": {
      const w = num(p, "width", 0.07), d = num(p, "depth", 0.05), t = num(p, "thickness", 0.0016);
      const rand = seeded(w * 1000 + d * 100);
      const chips: THREE.BufferGeometry[] = [], smd: THREE.BufferGeometry[] = [], pads: THREE.BufferGeometry[] = [];
      chips.push(box(w * 0.22, t * 1.2, w * 0.22, -w * 0.12, t * 1.1, 0));
      for (let i = 0; i < 6; i++) chips.push(box(w * (0.05 + rand() * 0.06), t * 0.9, d * (0.04 + rand() * 0.05), w * (0.1 + rand() * 0.3), t * 0.95, d * (rand() - 0.5) * 0.7));
      for (let i = 0; i < 14; i++) smd.push(box(w * 0.025, t * 0.6, d * 0.018, (rand() - 0.5) * w * 0.8, t * 0.8, (rand() - 0.5) * d * 0.8));
      const pins = Math.min(20, Math.round(num(p, "pins", 8)));
      const pinRow = Array.from({ length: pins }, (_, i) => box(0.0006, 0.006, 0.0006, -w * 0.4 + (i * (w * 0.8)) / Math.max(1, pins - 1), t / 2 + 0.003, -d / 2 + d * 0.08));
      for (const [x, z] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) pads.push(ring(Math.min(w, d) * 0.045, Math.min(w, d) * 0.025, t / 2, t / 2 + 0.00006, 16).translate(x * (w / 2 - w * 0.06), 0, z * (d / 2 - d * 0.08)));
      return [
        { geometry: box(w, t, d), finish: "pcb" },
        { geometry: mergeAll(chips), finish: "plastic" },
        { geometry: mergeAll(smd), finish: "nylon" },
        { geometry: mergeAll([...pinRow, box(w * 0.82, 0.0025, 0.0025, 0, t / 2 + 0.00125, -d / 2 + d * 0.08)]), finish: "gold" },
        { geometry: mergeAll(pads), finish: "gold" },
      ];
    }
    case "connector": {
      const w = num(p, "width", 0.016), h = num(p, "height", 0.008), d = num(p, "depth", 0.012), pins = Math.min(16, Math.max(1, Math.round(num(p, "pins", 4))));
      const holes = Array.from({ length: pins }, (_, i) => box(w * 0.08, h * 0.02, h * 0.3, -w * 0.38 + (i * w * 0.76) / Math.max(1, pins - 1), -h / 2 - 0.00005, 0));
      const leads = Array.from({ length: pins }, (_, i) => box(w * 0.04, h * 0.5, h * 0.12, -w * 0.38 + (i * w * 0.76) / Math.max(1, pins - 1), h / 2 + h * 0.25, 0));
      return [
        { geometry: box(w, h, d), finish: "main" },
        { geometry: box(w * 0.3, h * 0.25, d * 0.12, 0, h * 0.15, d / 2 + d * 0.06), finish: "main" },
        { geometry: mergeAll(holes), finish: "dark" },
        { geometry: mergeAll(leads), finish: "gold" },
      ];
    }
    case "cable": {
      const cr = num(p, "radius", 0.002), L = num(p, "length", 0.15);
      const end = new THREE.Vector3(Number.isFinite(p.dx) ? p.dx : 0, Number.isFinite(p.dy) ? p.dy : L * 0.7, Number.isFinite(p.dz) ? p.dz : L * 0.25);
      const a = end.clone().multiplyScalar(-0.5), b = end.clone().multiplyScalar(0.5), sag = Number.isFinite(p.sag) ? p.sag : L * 0.15;
      const side = new THREE.Vector3(end.z, 0, -end.x).normalize().multiplyScalar(sag * 0.6);
      const curve = new THREE.CatmullRomCurve3([a, a.clone().lerp(b, 0.3).add(side).add(new THREE.Vector3(0, -sag, 0)), a.clone().lerp(b, 0.7).sub(side).add(new THREE.Vector3(0, -sag * 0.5, 0)), b]);
      const tA = curve.getTangent(0), tB = curve.getTangent(1);
      return [
        { geometry: new THREE.TubeGeometry(curve, 48, cr, 10, false), finish: "main" },
        { geometry: orientedCylinder(cr * 1.6, cr * 5, a.clone().addScaledVector(tA, cr * 2.5), tA, 12), finish: "plastic" },
        { geometry: orientedCylinder(cr * 1.6, cr * 5, b.clone().addScaledVector(tB, -cr * 2.5), tB, 12), finish: "plastic" },
      ];
    }
    case "housing": {
      const w = num(p, "width", 0.08), h = num(p, "height", 0.04), d = num(p, "depth", 0.06), wall = num(p, "wall", Math.min(w, d) * 0.06);
      const walls = [box(w, wall, d, 0, -h / 2 + wall / 2, 0), box(wall, h, d, -w / 2 + wall / 2, 0, 0), box(wall, h, d, w / 2 - wall / 2, 0, 0), box(w - wall * 2, h, wall, 0, 0, -d / 2 + wall / 2), box(w - wall * 2, h, wall, 0, 0, d / 2 - wall / 2)];
      const bosses = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, z]) => ring(wall * 1.3, wall * 0.5, -h / 2 + wall, h / 2 - wall * 0.5, 16).translate(x * (w / 2 - wall * 2), 0, z * (d / 2 - wall * 2)));
      return [{ geometry: mergeAll(walls), finish: "main" }, { geometry: mergeAll(bosses), finish: "main" }];
    }
    case "cap": {
      const wall = num(p, "wall", r * 0.12), c = r * 0.08;
      return [{ geometry: lathe([[0, len / 2], [r - c, len / 2], [r, len / 2 - c], [r, -len / 2], [r - wall, -len / 2], [r - wall, len / 2 - wall], [0, len / 2 - wall]], 40), finish: "main" }];
    }
    default:
      return [{ geometry: new THREE.BoxGeometry(num(p, "width", 0.05), num(p, "height", 0.05), num(p, "depth", 0.05)), finish: "main" }];
  }
}

function mergeAll(geometries: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const prepared = geometries.map((g) => {
    const flat = g.index ? g.toNonIndexed() : g;
    for (const name of Object.keys(flat.attributes)) if (!["position", "normal", "uv"].includes(name)) flat.deleteAttribute(name);
    if (!flat.attributes.normal) flat.computeVertexNormals();
    if (!flat.attributes.uv) flat.setAttribute("uv", new THREE.Float32BufferAttribute(new Float32Array((flat.attributes.position.count) * 2), 2));
    flat.clearGroups();
    return flat;
  });
  const merged = prepared.length === 1 ? prepared[0] : mergeGeometries(prepared, false);
  return merged ?? prepared[0];
}

// Centres the pieces on their combined bounding-box centre.
function centre(pieces: Piece[]) {
  const bounds = new THREE.Box3();
  for (const piece of pieces) { piece.geometry.computeBoundingBox(); bounds.union(piece.geometry.boundingBox!); }
  const c = bounds.getCenter(new THREE.Vector3());
  if (c.lengthSq() > 0) for (const piece of pieces) piece.geometry.translate(-c.x, -c.y, -c.z);
  return pieces;
}

export function primitivePieces(shape: string, params: Record<string, number>): Piece[] {
  return centre(shapePieces(shape, params ?? {}));
}

// Single merged geometry for a primitive (all finishes combined). Used by the editor and for simple previews.
export function primitiveGeometry(shape: string, p: Record<string, number>): THREE.BufferGeometry {
  const merged = mergeAll(primitivePieces(shape, p).map((piece) => piece.geometry));
  merged.computeBoundingSphere();
  return merged;
}

// Material instances are per part, so highlight effects (emissive pulses) never bleed between parts.
export async function buildPartObject(part: ForgePart): Promise<THREE.Object3D> {
  const holder = new THREE.Group();
  holder.name = part.id;
  holder.userData.partId = part.id;
  if (part.geometry.kind === "mesh") {
    const { assetId, node } = part.geometry;
    try {
      const scene = await loadAsset(assetId);
      const source = scene.getObjectByName(node) ?? scene;
      const copy = source.clone(true);
      copy.position.set(0, 0, 0); copy.quaternion.identity();
      copy.traverse((child) => {
        if (!(child instanceof THREE.Mesh)) return;
        const original = Array.isArray(child.material) ? child.material[0] : child.material;
        const material = partMaterial("main", part.category, part.color ?? (original && "color" in original ? `#${(original.color as THREE.Color).getHexString()}` : undefined));
        child.material = material;
        child.castShadow = true; child.receiveShadow = true;
      });
      holder.add(copy);
    } catch {
      holder.add(new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.03, 0.03), partMaterial("main", part.category, part.color)));
      holder.userData.missingAsset = true;
    }
  } else {
    const materials = new Map<Finish, THREE.MeshStandardMaterial>();
    for (const piece of primitivePieces(part.geometry.shape, part.geometry.params)) {
      let material = materials.get(piece.finish);
      if (!material) { material = partMaterial(piece.finish, part.category, piece.finish === "main" ? part.color : undefined); materials.set(piece.finish, material); }
      const mesh = new THREE.Mesh(piece.geometry, material);
      mesh.castShadow = true; mesh.receiveShadow = true;
      holder.add(mesh);
    }
  }
  holder.traverse((child) => { child.userData.partId = part.id; });
  return holder;
}

export function applyTransform(object: THREE.Object3D, transform: Transform) {
  object.position.set(...transform.position);
  object.quaternion.set(...transform.quaternion);
}

export function readTransform(object: THREE.Object3D): Transform {
  return { position: [object.position.x, object.position.y, object.position.z], quaternion: [object.quaternion.x, object.quaternion.y, object.quaternion.z, object.quaternion.w] };
}
