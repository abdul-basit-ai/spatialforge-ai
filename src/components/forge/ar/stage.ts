"use client";

import * as THREE from "three";
import type { RunState, Verdict } from "@/lib/forge/engine";
import { applyTransform, buildPartObject, readTransform } from "@/lib/forge/three-parts";
import type { ForgePart, ForgeScenario, Transform } from "@/lib/forge/types";
import { canvasToJpeg } from "./camera";

// Imperative AR stage shared by AR training and AR assist. One code path for WebXR immersive-ar (hit-test + dom-overlay)
// and the screen-locked camera fallback: an anchor group sits on a real (or virtual) table, the assembly frame lives inside
// it at a chosen scale, and every drag is a ray intersected with a horizontal plane at the part's seat height.
// The stage never decides correctness: drops are handed to onDrop (the engine via useForgeRun) and the verdict is animated.

export type StageMode = "train" | "assist";
export type StageStatus = { xr: boolean; placed: boolean; surface: boolean; snapId: string | null; dragging: string | null; selectedId: string | null };
export type StageView = { run: RunState | null; ghostIds: string[]; arrowIds: string[]; outline: boolean; locked: boolean };
export type StageEvents = { onSelect?: (partId: string | null) => void; onDrop?: (partId: string, pose: Transform) => Verdict | null; onStatus?: (status: StageStatus) => void; onXrEnd?: () => void };

type Rec = {
  part: ForgePart; solid: THREE.Object3D; ghost: THREE.Object3D; outline: THREE.Object3D; radius: number;
  mats: Array<{ mat: THREE.MeshStandardMaterial; color: THREE.Color; intensity: number }>;
  ghostMats: THREE.Material[]; staging: Transform; rest: Transform;
  pos: THREE.Vector3; quat: THREE.Quaternion; flash: { color: THREE.Color; until: number } | null;
};

const CYAN = new THREE.Color("#38d9f5"), AMBER = new THREE.Color("#ffb547"), GREEN = new THREE.Color("#4ade80"), RED = new THREE.Color("#ff4d5e");
const UP = new THREE.Vector3(0, 1, 0);
const v3 = (a: readonly number[]) => new THREE.Vector3(a[0], a[1], a[2]);

function shadowTexture() {
  const c = document.createElement("canvas"); c.width = c.height = 128;
  const g = c.getContext("2d")!; const grad = g.createRadialGradient(64, 64, 4, 64, 64, 64);
  grad.addColorStop(0, "rgba(0,0,0,0.5)"); grad.addColorStop(0.6, "rgba(0,0,0,0.18)"); grad.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = grad; g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

function makeArrow(length: number) {
  const group = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({ color: AMBER, transparent: true, opacity: 0.95, depthTest: false });
  const r = length * 0.07;
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(r, r, length * 0.68, 12), mat); shaft.position.y = length * 0.34;
  const head = new THREE.Mesh(new THREE.ConeGeometry(r * 2.6, length * 0.32, 16), mat); head.position.y = length * 0.84;
  group.add(shaft, head); group.renderOrder = 10; group.traverse((o) => { o.renderOrder = 10; });
  group.userData.length = length;
  return group;
}

export class ARStage {
  readonly renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(50, 1, 0.005, 60);
  private anchor = new THREE.Group(); // on the table: world position, yaw, scale
  private assembly = new THREE.Group(); // assembly frame (offset so the lowest assembled point rests on the table)
  private reticle: THREE.Mesh;
  private shadow: THREE.Mesh;
  private mat: THREE.Mesh;
  private recs = new Map<string, Rec>();
  private arrows = new Map<string, THREE.Group>();
  private view: StageView = { run: null, ghostIds: [], arrowIds: [], outline: false, locked: false };
  private status: StageStatus = { xr: false, placed: false, surface: false, snapId: null, dragging: null, selectedId: null };
  private tableY = 0; private asmRadius = 0.1; private scale = 1;
  private orbit = { yaw: 0, pitch: 0.82, zoom: 1 };
  private fitRadius = 0.2;
  private drag: { id: string | null; source: XRInputSource | null; pointerId: number | null; moved: number; start: THREE.Vector3 | null; mode: "part" | "orbit" | "anchor"; lastX: number; lastY: number } | null = null;
  private pointers = new Map<number, { x: number; y: number }>();
  private pinch: number | null = null;
  private session: XRSession | null = null;
  private refSpace: XRReferenceSpace | null = null;
  private hitSource: XRHitTestSource | null = null;
  private capture: { resolve: (url: string | null) => void; at: number } | null = null;
  private disposed = false;
  private ready: Promise<void>;
  private resizeObserver: ResizeObserver;

  constructor(private host: HTMLElement, private scenario: ForgeScenario, private mode: StageMode, private events: StageEvents = {}) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.domElement.style.touchAction = "none";
    host.appendChild(this.renderer.domElement);
    this.scene.add(new THREE.HemisphereLight("#f4f7ff", "#2a3340", 1.5));
    const sun = new THREE.DirectionalLight("#ffffff", 1.6); sun.position.set(0.6, 1.4, 0.9); this.scene.add(sun);
    this.reticle = new THREE.Mesh(new THREE.RingGeometry(0.045, 0.06, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: CYAN, transparent: true, opacity: 0.9 }));
    const dot = new THREE.Mesh(new THREE.CircleGeometry(0.008, 20).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: AMBER }));
    this.reticle.add(dot); this.reticle.matrixAutoUpdate = false; this.reticle.visible = false; this.scene.add(this.reticle);
    this.shadow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: shadowTexture(), transparent: true, depthWrite: false }));
    this.shadow.position.y = 0.0006; this.anchor.add(this.shadow);
    this.mat = new THREE.Mesh(new THREE.RingGeometry(0.98, 1, 96).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: CYAN, transparent: true, opacity: 0.35, depthWrite: false }));
    this.mat.position.y = 0.0004; this.anchor.add(this.mat);
    this.anchor.add(this.assembly); this.scene.add(this.anchor);
    this.anchor.visible = false;
    this.resize();
    this.resizeObserver = new ResizeObserver(() => this.resize()); this.resizeObserver.observe(host);
    const canvas = this.renderer.domElement;
    canvas.addEventListener("pointerdown", this.onPointerDown); canvas.addEventListener("pointermove", this.onPointerMove);
    canvas.addEventListener("pointerup", this.onPointerUp); canvas.addEventListener("pointercancel", this.onPointerUp);
    canvas.addEventListener("wheel", this.onWheel, { passive: false });
    this.ready = this.load();
    this.renderer.setAnimationLoop(this.frame);
    if (process.env.NODE_ENV !== "production") (window as unknown as { __arStage?: ARStage }).__arStage = this; // e2e hook (dev only)
  }

  // Client coordinates of a part's current position or its seat (used by e2e tests and onboarding pointers).
  screenPoint(partId: string, seat = false): { x: number; y: number } | null {
    const rec = this.recs.get(partId); if (!rec) return null;
    this.assembly.updateMatrixWorld(true);
    const p = seat ? v3(rec.part.assembled.position) : new THREE.Box3().setFromObject(rec.solid).getCenter(new THREE.Vector3()).applyMatrix4(this.assembly.matrixWorld.clone().invert());
    const world = p.applyMatrix4(this.assembly.matrixWorld).project(this.camera);
    const r = this.renderer.domElement.getBoundingClientRect();
    return { x: r.left + ((world.x + 1) / 2) * r.width, y: r.top + ((1 - world.y) / 2) * r.height };
  }

  // ---------- setup ----------
  private async load() {
    const box = new THREE.Box3();
    const order = new Map(this.scenario.steps.flatMap((step, i) => step.partIds.map((id) => [id, i] as const)).reverse());
    await Promise.all(this.scenario.parts.map(async (part) => {
      let solid: THREE.Object3D;
      try { solid = await buildPartObject(part); } catch { solid = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.02, 0.02), new THREE.MeshStandardMaterial({ color: part.color ?? "#9fb3c8" })); solid.userData.partId = part.id; }
      if (this.disposed) return;
      const mats: Rec["mats"] = [];
      solid.traverse((o) => {
        if (!(o instanceof THREE.Mesh)) return;
        o.material = Array.isArray(o.material) ? o.material.map((m) => m.clone()) : o.material.clone();
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) if (m instanceof THREE.MeshStandardMaterial) mats.push({ mat: m, color: m.emissive.clone(), intensity: m.emissiveIntensity });
      });
      const ghostMats: THREE.Material[] = [];
      const ghost = solid.clone(true); const outline = new THREE.Group();
      ghost.traverse((o) => {
        if (!(o instanceof THREE.Mesh)) return;
        const fill = new THREE.MeshBasicMaterial({ color: CYAN, transparent: true, opacity: 0.28, depthWrite: false }); ghostMats.push(fill); o.material = fill;
        const edges = new THREE.LineSegments(new THREE.EdgesGeometry(o.geometry, 28), new THREE.LineBasicMaterial({ color: CYAN, transparent: true, opacity: 0.9 }));
        ghostMats.push(edges.material as THREE.Material); o.add(edges);
      });
      solid.updateMatrixWorld(true);
      solid.traverse((o) => {
        if (!(o instanceof THREE.Mesh)) return;
        const line = new THREE.LineSegments(new THREE.EdgesGeometry(o.geometry, 28), new THREE.LineBasicMaterial({ color: "#9ee8ff", transparent: true, opacity: 0.55 }));
        line.matrixAutoUpdate = false; line.matrix.copy(o.matrixWorld); outline.add(line);
      });
      applyTransform(solid, part.assembled); solid.updateMatrixWorld(true);
      const partBox = new THREE.Box3().setFromObject(solid); box.union(partBox);
      const radius = Math.max(0.006, partBox.getSize(new THREE.Vector3()).length() / 2);
      applyTransform(ghost, part.assembled); applyTransform(outline, part.assembled);
      ghost.visible = false; outline.visible = false;
      this.assembly.add(solid, ghost, outline);
      this.recs.set(part.id, { part, solid, ghost, outline, radius, mats, ghostMats, staging: part.assembled, rest: part.assembled, pos: v3(part.assembled.position), quat: new THREE.Quaternion(...part.assembled.quaternion), flash: null });
    }));
    if (this.disposed) return;
    this.tableY = Number.isFinite(box.min.y) ? box.min.y : 0;
    const size = box.isEmpty() ? new THREE.Vector3(0.2, 0.2, 0.2) : box.getSize(new THREE.Vector3());
    this.asmRadius = Math.max(0.04, Math.hypot(size.x, size.z) / 2);
    this.assembly.position.y = -this.tableY;
    // Staging: unplaced parts rest on the table in an arc in front of the assembly (toward the user), ordered by step.
    const loose = this.scenario.parts.filter((p) => !this.scenario.baseParts.includes(p.id)).sort((a, b) => (order.get(a.id) ?? 99) - (order.get(b.id) ?? 99));
    const perRow = 7; let maxR = 0;
    loose.forEach((part, i) => {
      const rec = this.recs.get(part.id)!; const row = Math.floor(i / perRow), col = i % perRow, inRow = Math.min(perRow, loose.length - row * perRow);
      const R = this.asmRadius * 1.25 + 0.05 + row * Math.max(0.05, rec.radius * 2.4);
      const angle = inRow === 1 ? 0 : -1.95 + (3.9 * col) / (inRow - 1) + (row % 2 ? 0.2 : 0);
      const quat = new THREE.Quaternion(...part.assembled.quaternion);
      // Keyed parts start a quarter turn off on alternate parts, so orientation is part of the lesson.
      const sym = part.mate.symmetryDeg ?? 360;
      if (this.mode === "train" && part.mate.axis && i % 2 === 1 && sym >= 180) quat.premultiply(new THREE.Quaternion().setFromAxisAngle(v3(part.mate.axis).normalize(), Math.PI / 2));
      rec.solid.position.set(0, 0, 0); rec.solid.quaternion.copy(quat); rec.solid.updateMatrixWorld(true);
      const b = new THREE.Box3().setFromObject(rec.solid);
      const position: [number, number, number] = [Math.sin(angle) * R - (b.min.x + b.max.x) / 2, this.tableY - b.min.y + 0.001, Math.cos(angle) * R - (b.min.z + b.max.z) / 2];
      rec.staging = rec.rest = { position, quaternion: [quat.x, quat.y, quat.z, quat.w] };
      maxR = Math.max(maxR, R + rec.radius);
    });
    const shadowSize = this.asmRadius * 2.8; this.shadow.scale.set(shadowSize, 1, shadowSize);
    const matR = Math.max(this.asmRadius * 1.15, maxR + 0.015); this.mat.scale.set(matR, 1, matR);
    this.fitRadius = this.mode === "assist" ? this.asmRadius * 1.5 : matR * 0.9;
    this.applyView(true);
  }

  whenReady() { return this.ready; }

  private resize = () => {
    if (this.renderer.xr.isPresenting) return;
    const w = Math.max(1, this.host.clientWidth), h = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(w, h); this.camera.aspect = w / h;
    // Portrait phones: the bottom sheet covers the lower screen, so shift the optical centre up.
    const k = h > w ? Math.round(h * 0.16) : 0;
    if (k) this.camera.setViewOffset(w, h + 2 * k, 0, 2 * k, w, h); else this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();
  };

  // ---------- view state from React ----------
  setView(view: Partial<StageView>) {
    const prevInstalled = this.view.run?.installed ?? [];
    this.view = { ...this.view, ...view };
    const installed = this.view.run?.installed ?? [];
    if (installed.length < prevInstalled.length) for (const rec of this.recs.values()) rec.rest = rec.staging; // reset
    this.applyView(false);
  }

  private applyView(snapNow: boolean) {
    const installed = new Set(this.view.run ? this.view.run.installed : this.scenario.parts.map((p) => p.id));
    const ghosts = new Set(this.view.ghostIds);
    for (const [id, rec] of this.recs) {
      const isIn = installed.has(id);
      if (this.mode === "train") {
        rec.solid.visible = true; rec.outline.visible = false;
        rec.ghost.visible = ghosts.has(id) && !isIn;
      } else {
        rec.solid.visible = false; rec.outline.visible = this.view.outline && isIn; rec.ghost.visible = ghosts.has(id);
      }
      if (this.drag?.id === id) continue;
      const target = isIn ? rec.part.assembled : rec.rest;
      if (snapNow || this.mode === "assist") { rec.pos.copy(v3(target.position)); rec.quat.set(...target.quaternion); applyTransform(rec.solid, target); }
      else { rec.pos.copy(v3(target.position)); rec.quat.set(...target.quaternion); }
    }
    for (const [id, arrow] of this.arrows) if (!this.view.arrowIds.includes(id)) { this.assembly.remove(arrow); this.arrows.delete(id); }
    for (const id of this.view.arrowIds) {
      const rec = this.recs.get(id); if (!rec || this.arrows.has(id)) continue;
      const arrow = makeArrow(Math.max(0.03, Math.min(0.12, rec.radius * 1.8)));
      const axis = v3(rec.part.mate.axis ?? [0, -1, 0]).normalize();
      arrow.quaternion.setFromUnitVectors(UP, axis); arrow.userData.axis = axis; arrow.userData.seat = v3(rec.part.assembled.position);
      this.arrows.set(id, arrow); this.assembly.add(arrow);
    }
    this.shadow.visible = this.mode === "train"; this.mat.visible = this.mode === "train";
  }

  // ---------- anchor controls ----------
  setScale(scale: number) { this.scale = scale; this.anchor.scale.setScalar(scale); if (!this.status.xr) this.orbit.zoom = 1; }
  rotateAnchor(deg: number) { this.anchor.rotation.y += THREE.MathUtils.degToRad(deg); }
  // Nudge in metres in the anchor's own axes (x right, y up, z toward the user).
  nudge(dx: number, dy: number, dz: number) { this.anchor.translateX(dx); this.anchor.position.y += dy; this.anchor.translateZ(dz); }
  resetAnchor() { this.anchor.position.set(0, 0, 0); this.anchor.rotation.set(0, 0, 0); this.setStatus({ placed: !this.status.xr }); this.anchor.visible = !this.status.xr; }
  placeFallback() { this.anchor.position.set(0, 0, 0); this.anchor.visible = true; this.setStatus({ placed: true }); }

  rotateSelected(deg: number) {
    const id = this.status.selectedId; const rec = id ? this.recs.get(id) : null;
    if (!rec || this.view.run?.installed.includes(rec.part.id)) return;
    const axis = v3(rec.part.mate.axis ?? [0, 1, 0]).normalize();
    rec.quat.premultiply(new THREE.Quaternion().setFromAxisAngle(axis, THREE.MathUtils.degToRad(deg)));
    rec.rest = { position: rec.rest.position, quaternion: [rec.quat.x, rec.quat.y, rec.quat.z, rec.quat.w] };
  }
  select(id: string | null) { this.setStatus({ selectedId: id }); this.events.onSelect?.(id); }
  flash(id: string, ok: boolean) { const rec = this.recs.get(id); if (rec) rec.flash = { color: ok ? GREEN : RED, until: performance.now() + 700 }; }

  private setStatus(patch: Partial<StageStatus>) {
    const next = { ...this.status, ...patch };
    if ((Object.keys(next) as Array<keyof StageStatus>).every((k) => next[k] === this.status[k])) return;
    this.status = next; this.events.onStatus?.(next);
  }

  // ---------- picking and dragging (shared by pointer and XR rays) ----------
  private pickPart(ray: THREE.Ray): string | null {
    if (this.mode !== "train" || !this.status.placed) return null;
    const installed = new Set(this.view.run?.installed ?? []);
    const candidates = [...this.recs.values()].filter((r) => !installed.has(r.part.id) && r.solid.visible);
    const caster = new THREE.Raycaster(ray.origin, ray.direction, 0, 100);
    const hit = caster.intersectObjects(candidates.map((r) => r.solid), true)[0];
    if (hit) { let o: THREE.Object3D | null = hit.object; while (o && !o.userData.partId) o = o.parent; if (o) return o.userData.partId as string; }
    // Small parts: accept the nearest part whose centre is close to the ray.
    let best: string | null = null, bestScore = Infinity;
    for (const r of candidates) {
      const c = new THREE.Box3().setFromObject(r.solid).getCenter(new THREE.Vector3());
      const d = ray.distanceToPoint(c), range = c.distanceTo(ray.origin);
      const limit = Math.max(r.radius * this.scale * 1.6, range * 0.045);
      if (d < limit && d / limit < bestScore) { bestScore = d / limit; best = r.part.id; }
    }
    return best;
  }

  // Ray (world) -> point on the horizontal plane at `y` in the assembly frame.
  private rayToAssembly(ray: THREE.Ray, y: number): THREE.Vector3 | null {
    this.assembly.updateMatrixWorld(true);
    const local = ray.clone().applyMatrix4(this.assembly.matrixWorld.clone().invert());
    return local.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -y), new THREE.Vector3());
  }

  private snapRadius(rec: Rec) { return Math.max(rec.part.mate.positionTolerance * 4, rec.radius * 0.7, 0.015); }

  private beginDrag(ray: THREE.Ray, source: XRInputSource | null, pointerId: number | null, x = 0, y = 0) {
    const id = this.pickPart(ray);
    if (id) { this.select(id); this.drag = { id, source, pointerId, moved: 0, start: this.rayToAssembly(ray, this.recs.get(id)!.part.assembled.position[1]), mode: "part", lastX: x, lastY: y }; this.setStatus({ dragging: id }); return true; }
    return false;
  }

  private updateDrag(ray: THREE.Ray) {
    const drag = this.drag; if (!drag?.id) return;
    const rec = this.recs.get(drag.id)!; const seat = v3(rec.part.assembled.position);
    const hit = this.rayToAssembly(ray, seat.y); if (!hit) return;
    if (drag.start) drag.moved = Math.max(drag.moved, hit.distanceTo(drag.start) * this.scale);
    if (drag.moved < 0.004) return;
    const flat = Math.hypot(hit.x - seat.x, hit.z - seat.z);
    if (flat < this.snapRadius(rec)) { rec.pos.copy(seat); this.setStatus({ snapId: rec.part.id }); }
    else { rec.pos.set(hit.x, seat.y + Math.max(0.01, rec.radius * 0.5), hit.z); this.setStatus({ snapId: null }); }
  }

  private endDrag() {
    const drag = this.drag; this.drag = null;
    this.setStatus({ dragging: null, snapId: null });
    if (!drag?.id) return;
    const rec = this.recs.get(drag.id)!;
    if (drag.moved < 0.004) { this.applyView(false); return; } // a tap: selection only
    const seat = v3(rec.part.assembled.position);
    const flat = Math.hypot(rec.pos.x - seat.x, rec.pos.z - seat.z), snap = this.snapRadius(rec);
    const nearOther = [...this.recs.values()].some((r) => r !== rec && !this.view.run?.installed.includes(r.part.id) && Math.hypot(rec.pos.x - r.part.assembled.position[0], rec.pos.z - r.part.assembled.position[2]) < this.snapRadius(r));
    const pose: Transform = { position: [rec.pos.x, rec.pos.y, rec.pos.z], quaternion: [rec.quat.x, rec.quat.y, rec.quat.z, rec.quat.w] };
    if (flat < snap * 2.5 || nearOther) {
      const verdict = this.events.onDrop?.(rec.part.id, flat < snap ? { position: rec.part.assembled.position, quaternion: pose.quaternion } : pose);
      this.flash(rec.part.id, Boolean(verdict?.ok));
      if (verdict?.ok) { this.select(null); return; }
      this.applyView(false); return;
    }
    // Dropped away from any seat: just set it down on the table there (not a mistake).
    const quat = rec.quat.clone();
    const tmp = rec.solid.clone(true); tmp.position.set(0, 0, 0); tmp.quaternion.copy(quat); tmp.updateMatrixWorld(true);
    const b = new THREE.Box3().setFromObject(tmp);
    rec.rest = { position: [rec.pos.x, this.tableY - b.min.y + 0.001, rec.pos.z], quaternion: [quat.x, quat.y, quat.z, quat.w] };
    this.applyView(false);
  }

  // ---------- fallback (screen-locked) input ----------
  private ndcRay(e: { clientX: number; clientY: number }) {
    const r = this.renderer.domElement.getBoundingClientRect();
    const caster = new THREE.Raycaster(); caster.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), this.camera);
    return caster.ray;
  }

  private onPointerDown = (e: PointerEvent) => {
    if (this.status.xr) return;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.renderer.domElement.setPointerCapture(e.pointerId);
    if (this.pointers.size === 2) { this.drag = null; this.setStatus({ dragging: null, snapId: null }); const [a, b] = [...this.pointers.values()]; this.pinch = Math.hypot(a.x - b.x, a.y - b.y); return; }
    const ray = this.ndcRay(e);
    if (this.beginDrag(ray, null, e.pointerId, e.clientX, e.clientY)) return;
    const canMoveAnchor = this.mode === "assist" && !this.view.locked;
    if (canMoveAnchor) { const p = ray.intersectPlane(new THREE.Plane(UP, 0), new THREE.Vector3()); if (p) { this.anchor.position.set(p.x, 0, p.z); this.anchor.visible = true; this.setStatus({ placed: true }); } }
    this.drag = { id: null, source: null, pointerId: e.pointerId, moved: 0, start: null, mode: canMoveAnchor ? "anchor" : "orbit", lastX: e.clientX, lastY: e.clientY };
  };

  private onPointerMove = (e: PointerEvent) => {
    if (this.status.xr || !this.pointers.has(e.pointerId)) return;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pinch && this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()]; const d = Math.hypot(a.x - b.x, a.y - b.y);
      this.orbit.zoom = THREE.MathUtils.clamp(this.orbit.zoom * (this.pinch / Math.max(d, 1)), 0.35, 3); this.pinch = d; return;
    }
    const drag = this.drag; if (!drag || drag.pointerId !== e.pointerId) return;
    if (drag.mode === "part") { this.updateDrag(this.ndcRay(e)); return; }
    const dx = e.clientX - drag.lastX, dy = e.clientY - drag.lastY; drag.lastX = e.clientX; drag.lastY = e.clientY;
    if (drag.mode === "orbit") { this.orbit.yaw -= dx * 0.008; this.orbit.pitch = THREE.MathUtils.clamp(this.orbit.pitch + dy * 0.006, 0.12, 1.45); }
    else { const p = this.ndcRay(e).intersectPlane(new THREE.Plane(UP, 0), new THREE.Vector3()); if (p) this.anchor.position.set(p.x, 0, p.z); }
  };

  private onPointerUp = (e: PointerEvent) => {
    this.pointers.delete(e.pointerId); if (this.pointers.size < 2) this.pinch = null;
    if (this.drag?.pointerId === e.pointerId) { if (this.drag.mode === "part") this.endDrag(); else { if (this.drag.mode === "orbit" && this.mode === "train" && Math.abs(e.clientX - this.drag.lastX) < 2) this.select(null); this.drag = null; } }
  };

  private onWheel = (e: WheelEvent) => { if (this.status.xr) return; e.preventDefault(); this.orbit.zoom = THREE.MathUtils.clamp(this.orbit.zoom * (1 + Math.sign(e.deltaY) * 0.1), 0.35, 3); };

  // ---------- WebXR ----------
  static async arSupported(): Promise<boolean> {
    const xr = (navigator as Navigator & { xr?: XRSystem }).xr;
    try { return Boolean(xr && (await xr.isSessionSupported("immersive-ar"))); } catch { return false; }
  }

  async startXR(overlay: HTMLElement): Promise<boolean> {
    const xr = (navigator as Navigator & { xr?: XRSystem }).xr; if (!xr) return false;
    await this.ready;
    const session = await xr.requestSession("immersive-ar", { requiredFeatures: ["hit-test"], optionalFeatures: ["dom-overlay", "camera-access", "local-floor"], domOverlay: { root: overlay } } as XRSessionInit);
    this.session = session;
    this.renderer.xr.enabled = true; this.renderer.xr.setReferenceSpaceType("local");
    await this.renderer.xr.setSession(session);
    this.refSpace = this.renderer.xr.getReferenceSpace();
    const viewer = await session.requestReferenceSpace("viewer");
    this.hitSource = (await session.requestHitTestSource?.({ space: viewer })) ?? null;
    this.anchor.visible = false; this.setStatus({ xr: true, placed: false, surface: false });
    session.addEventListener("selectstart", this.onXrSelectStart as EventListener);
    session.addEventListener("selectend", this.onXrSelectEnd as EventListener);
    session.addEventListener("select", this.onXrSelect as EventListener);
    session.addEventListener("end", this.onXrEnd);
    return true;
  }

  endXR() { void this.session?.end().catch(() => undefined); }
  get xrCameraAccess() { return Boolean(this.session?.enabledFeatures?.includes("camera-access")); }

  private onXrEnd = () => {
    this.hitSource?.cancel(); this.hitSource = null; this.session = null; this.refSpace = null; this.drag = null;
    this.renderer.xr.enabled = false; this.reticle.visible = false;
    this.capture?.resolve(null); this.capture = null;
    this.anchor.position.set(0, 0, 0); this.anchor.rotation.set(0, 0, 0); this.anchor.visible = true;
    this.setStatus({ xr: false, placed: true, surface: false, dragging: null, snapId: null });
    this.resize(); this.events.onXrEnd?.();
  };

  private xrRay(frame: XRFrame, source: XRInputSource): THREE.Ray | null {
    if (!this.refSpace) return null;
    const pose = frame.getPose(source.targetRaySpace, this.refSpace); if (!pose) return null;
    const m = new THREE.Matrix4().fromArray(pose.transform.matrix);
    const origin = new THREE.Vector3().setFromMatrixPosition(m);
    const dir = new THREE.Vector3(0, 0, -1).transformDirection(m);
    return new THREE.Ray(origin, dir);
  }

  private onXrSelectStart = (e: XRInputSourceEvent) => {
    if (!this.status.placed) return;
    const ray = this.xrRay(e.frame, e.inputSource);
    if (ray) this.beginDrag(ray, e.inputSource, null);
  };
  private onXrSelectEnd = () => { if (this.drag?.mode === "part") this.endDrag(); };
  private onXrSelect = () => {
    const canPlace = !this.status.placed || (this.mode === "assist" && !this.view.locked);
    if (!canPlace || !this.reticle.visible || this.drag) return;
    const m = this.reticle.matrix; const pos = new THREE.Vector3().setFromMatrixPosition(m);
    const cam = new THREE.Vector3().setFromMatrixPosition(this.renderer.xr.getCamera().matrixWorld);
    this.anchor.position.copy(pos); this.anchor.rotation.set(0, Math.atan2(cam.x - pos.x, cam.z - pos.z), 0);
    this.anchor.visible = true; this.setStatus({ placed: true });
  };

  // Resolves with a 768px JPEG of the raw camera frame (WebXR camera-access), or null when unavailable.
  captureXRFrame(): Promise<string | null> {
    if (!this.session || !this.xrCameraAccess) return Promise.resolve(null);
    return new Promise((resolve) => { this.capture = { resolve, at: performance.now() }; });
  }

  private readCameraFrame(frame: XRFrame): string | null {
    const pose = this.refSpace ? frame.getViewerPose(this.refSpace) : null;
    const view = pose?.views[0] as (XRView & { camera?: { width: number; height: number } }) | undefined;
    if (!view?.camera) return null;
    const binding = this.renderer.xr.getBinding() as XRWebGLBinding & { getCameraImage?: (camera: unknown) => WebGLTexture };
    const texture = binding?.getCameraImage?.(view.camera); if (!texture) return null;
    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    const { width, height } = view.camera;
    const previous = gl.getParameter(gl.FRAMEBUFFER_BINDING);
    const fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    const pixels = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    gl.bindFramebuffer(gl.FRAMEBUFFER, previous); gl.deleteFramebuffer(fb); this.renderer.resetState();
    const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext("2d")!; const image = ctx.createImageData(width, height);
    for (let y = 0; y < height; y++) image.data.set(pixels.subarray((height - 1 - y) * width * 4, (height - y) * width * 4), y * width * 4);
    ctx.putImageData(image, 0, 0);
    return canvasToJpeg(canvas, width, height);
  }

  // ---------- per-frame ----------
  private frame = (time: number, frame?: XRFrame) => {
    if (this.disposed) return;
    if (frame && this.session) {
      if (this.hitSource && this.refSpace) {
        const hit = frame.getHitTestResults(this.hitSource)[0]; const pose = hit?.getPose(this.refSpace);
        const wantReticle = !this.status.placed || (this.mode === "assist" && !this.view.locked);
        this.reticle.visible = Boolean(pose && wantReticle);
        if (pose) this.reticle.matrix.fromArray(pose.transform.matrix);
        this.setStatus({ surface: Boolean(pose) });
      }
      if (this.drag?.mode === "part" && this.drag.source) { const ray = this.xrRay(frame, this.drag.source); if (ray) this.updateDrag(ray); }
      if (this.capture) {
        let url: string | null = null;
        try { url = this.readCameraFrame(frame); } catch (error) { console.warn("camera-access capture failed", error); }
        if (url || performance.now() - this.capture.at > 1500) { this.capture.resolve(url); this.capture = null; }
      }
    } else {
      this.applyCamera();
    }
    const now = performance.now(), pulse = 0.5 + 0.5 * Math.sin(time / 260);
    for (const [id, rec] of this.recs) {
      if (this.mode === "train") {
        rec.solid.position.lerp(rec.pos, this.drag?.id === id ? 0.45 : 0.2); rec.solid.quaternion.slerp(rec.quat, 0.25);
        let color: THREE.Color | null = null, intensity = 0;
        if (rec.flash && rec.flash.until > now) { color = rec.flash.color; intensity = ((rec.flash.until - now) / 700) * 1.2; }
        else if (this.status.selectedId === id) { color = AMBER; intensity = 0.28 + 0.18 * pulse; }
        for (const m of rec.mats) { if (color) { m.mat.emissive.copy(color); m.mat.emissiveIntensity = intensity; } else { m.mat.emissive.copy(m.color); m.mat.emissiveIntensity = m.intensity; } }
      }
      if (rec.ghost.visible) {
        const snapped = this.status.snapId === id;
        for (const m of rec.ghostMats) {
          const mm = m as THREE.MeshBasicMaterial | THREE.LineBasicMaterial; mm.color.copy(snapped ? AMBER : CYAN);
          mm.opacity = m instanceof THREE.LineBasicMaterial ? 0.6 + 0.35 * pulse : (snapped ? 0.5 : 0.16 + 0.16 * pulse);
        }
      }
    }
    for (const arrow of this.arrows.values()) {
      const L = arrow.userData.length as number, axis = arrow.userData.axis as THREE.Vector3, seat = arrow.userData.seat as THREE.Vector3;
      const t = (time / 1100) % 1; const back = L * (2.1 - t * 1.0);
      arrow.position.copy(seat).addScaledVector(axis, -back);
      arrow.traverse((o) => { if (o instanceof THREE.Mesh) (o.material as THREE.MeshBasicMaterial).opacity = 0.35 + 0.6 * Math.sin(Math.PI * t); });
    }
    this.renderer.render(this.scene, this.camera);
  };

  private applyCamera() {
    const vfov = THREE.MathUtils.degToRad(this.camera.fov), hfov = 2 * Math.atan(Math.tan(vfov / 2) * this.camera.aspect);
    const d = ((this.fitRadius * this.scale) / Math.sin(Math.min(vfov, hfov) / 2)) * this.orbit.zoom;
    const target = new THREE.Vector3(this.anchor.position.x, this.anchor.position.y + this.asmRadius * 0.3 * this.scale, this.anchor.position.z);
    if (this.mode === "assist") target.set(0, this.asmRadius * 0.3 * this.scale, 0); // the camera view is screen-locked; the model moves instead
    const yaw = this.mode === "assist" ? 0 : this.orbit.yaw, pitch = this.mode === "assist" ? 0.75 : this.orbit.pitch;
    this.camera.position.set(target.x + Math.sin(yaw) * Math.cos(pitch) * d, target.y + Math.sin(pitch) * d, target.z + Math.cos(yaw) * Math.cos(pitch) * d);
    this.camera.lookAt(target);
  }

  get currentStatus() { return this.status; }
  get assemblyRadius() { return this.asmRadius; }
  readPose(id: string): Transform | null { const rec = this.recs.get(id); return rec ? readTransform(rec.solid) : null; }

  dispose() {
    this.disposed = true; this.endXR(); this.resizeObserver.disconnect();
    const canvas = this.renderer.domElement;
    canvas.removeEventListener("pointerdown", this.onPointerDown); canvas.removeEventListener("pointermove", this.onPointerMove);
    canvas.removeEventListener("pointerup", this.onPointerUp); canvas.removeEventListener("pointercancel", this.onPointerUp); canvas.removeEventListener("wheel", this.onWheel);
    this.renderer.setAnimationLoop(null);
    this.scene.traverse((o) => { if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments) { o.geometry.dispose(); for (const m of Array.isArray(o.material) ? o.material : [o.material]) m.dispose(); } });
    this.renderer.dispose(); canvas.remove();
  }
}
