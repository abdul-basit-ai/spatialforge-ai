"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import type { RunState } from "@/lib/forge/engine";
import { orientationError, stagingPose } from "@/lib/forge/engine";
import { buildPartObject } from "@/lib/forge/three-parts";
import type { ForgePart, ForgeScenario, Transform } from "@/lib/forge/types";

// Shared Forge 3D scene (contract). The trainer agent owns and extends this; editor and AR import it with these props.
export type ForgeSceneProps = {
  scenario: ForgeScenario;
  run?: RunState | null; // null/undefined: preview (every part assembled)
  exploded?: boolean; // preview: show parts at staging poses
  highlightPartIds?: string[];
  ghostPartIds?: string[]; // translucent copy at the assembled pose (next-step hint)
  selectedPartId?: string | null;
  interactive?: boolean; // allow picking and dragging parts
  transparentBackground?: boolean; // for camera pass-through overlays
  onPartSelect?: (partId: string | null) => void;
  onPartDrop?: (partId: string, pose: Transform) => void;
  className?: string;
  scrambleStaging?: boolean; // optional: staging parts start rotated by 90° multiples so orientation must be corrected
  showControls?: boolean; // optional: rotate/frame overlay buttons (default: when interactive)
};

type Entry = {
  id: string; part: ForgePart; object: THREE.Object3D; ghost: THREE.Object3D; ghostMaterial: THREE.MeshStandardMaterial;
  materials: THREE.MeshStandardMaterial[]; targetPos: THREE.Vector3; targetQuat: THREE.Quaternion;
  slot: Transform | null; userPose: Transform | null; installed: boolean; radius: number;
  flash: { color: THREE.Color; start: number; duration: number } | null;
};

type Drag = { entry: Entry; pointerId: number; plane: THREE.Plane; offset: THREE.Vector3; raw: THREE.Vector3; startX: number; startY: number; lastX: number; lastY: number; moved: boolean; depthPointer: number | null; depthY: number; snapping: boolean };

type Ctx = { sync: (animate: boolean) => void; rotate: (axis: "x" | "y" | "z", dir?: number) => void; frame: () => void; entries: Map<string, Entry> };

const EMPTY: string[] = [];
const COLORS = { cyan: new THREE.Color("#38d9f5"), amber: new THREE.Color("#ffb547"), green: new THREE.Color("#4dff9a"), red: new THREE.Color("#ff4d4d"), black: new THREE.Color("#000000") };
const AXES = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) };
const toTransform = (pos: THREE.Vector3, quat: THREE.Quaternion): Transform => ({ position: [pos.x, pos.y, pos.z], quaternion: [quat.x, quat.y, quat.z, quat.w] });
const hash = (text: string) => { let h = 2166136261; for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619); return h >>> 0; };
const niceStep = (value: number) => { const p = 10 ** Math.floor(Math.log10(value)); const n = value / p; return (n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10) * p; };

// Deterministic 90°-multiple scramble about world axes (always undoable with the R/T/Y rotations).
function scrambleQuat(id: string): THREE.Quaternion {
  const q = new THREE.Quaternion();
  switch (hash(id) % 6) {
    case 2: return q.setFromAxisAngle(AXES.y, Math.PI / 2);
    case 3: return q.setFromAxisAngle(AXES.y, Math.PI);
    case 4: return q.setFromAxisAngle(AXES.x, Math.PI / 2);
    case 5: return q.setFromAxisAngle(AXES.z, -Math.PI / 2);
    default: return q;
  }
}

function tableTexture() {
  const canvas = document.createElement("canvas"); canvas.width = canvas.height = 512;
  const g = canvas.getContext("2d")!;
  const grad = g.createRadialGradient(256, 256, 0, 256, 256, 256);
  grad.addColorStop(0, "rgba(28,36,46,1)"); grad.addColorStop(0.55, "rgba(19,25,33,1)"); grad.addColorStop(1, "rgba(10,14,19,0)");
  g.fillStyle = grad; g.fillRect(0, 0, 512, 512);
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export default function ForgeScene(props: ForgeSceneProps) {
  const { scenario, run, exploded, selectedPartId, interactive, transparentBackground, className, scrambleStaging } = props;
  const showControls = props.showControls ?? Boolean(interactive);
  const host = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLDivElement>(null);
  const ctxRef = useRef<Ctx | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const selectedRef = useRef<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const partsKey = useMemo(() => JSON.stringify(scenario.parts.map((part) => [part.id, part.geometry, part.color, part.category])), [scenario]);

  useEffect(() => {
    if (selectedPartId === undefined) return;
    selectedRef.current = selectedPartId; setSelected(selectedPartId);
  }, [selectedPartId]);

  // Scene setup: rebuilt only when the part geometry set (or background mode) changes.
  useEffect(() => {
    const el = host.current; if (!el) return;
    const transparent = Boolean(transparentBackground);
    let disposed = false;
    setReady(false);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: transparent, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2)); // lowered adaptively below if frames are slow
    renderer.setSize(Math.max(el.clientWidth, 1), Math.max(el.clientHeight, 1));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05;
    renderer.shadowMap.enabled = !transparent; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.shadowMap.autoUpdate = false; // re-rendered only on frames where something moved
    let pixelRatio = Math.min(window.devicePixelRatio, 2), frameTime = 16, slowFrames = 0, shadowDirty = true;
    const canvas = renderer.domElement;
    canvas.style.display = "block"; canvas.style.width = "100%"; canvas.style.height = "100%"; canvas.style.touchAction = "none"; canvas.style.outline = "none";
    el.appendChild(canvas);

    const scene = new THREE.Scene();
    if (!transparent) scene.background = new THREE.Color("#0a0e13");
    const pmrem = new THREE.PMREMGenerator(renderer);
    const envTexture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = envTexture; scene.environmentIntensity = 0.55;
    const hemi = new THREE.HemisphereLight("#d6ecff", "#161b22", 0.55); scene.add(hemi);
    const key = new THREE.DirectionalLight("#fff1dc", 2.4); key.castShadow = !transparent; key.shadow.mapSize.set(2048, 2048); scene.add(key, key.target);
    const rim = new THREE.DirectionalLight("#5fd8ff", 1.1); scene.add(rim);
    const fill = new THREE.DirectionalLight("#ffb547", 0.35); scene.add(fill);

    const camera = new THREE.PerspectiveCamera(40, el.clientWidth / Math.max(el.clientHeight, 1), 0.001, 60);
    camera.position.set(0.35, 0.3, 0.45);

    const entries = new Map<string, Entry>();
    const pickables: THREE.Object3D[] = [];
    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    const tmp = new THREE.Vector3(), tmp2 = new THREE.Vector3(), forward = new THREE.Vector3();
    let drag: Drag | null = null;
    let hovered: string | null = null;
    let pendingClick: { x: number; y: number } | null = null;
    const touches = new Map<number, { x: number; y: number }>();
    let radius = 0.15, tableY = 0;
    const center = new THREE.Vector3();
    let tween: { fromPos: THREE.Vector3; toPos: THREE.Vector3; fromTarget: THREE.Vector3; toTarget: THREE.Vector3; start: number; duration: number } | null = null;
    let bench: THREE.Group | null = null;

    const draggable = (entry: Entry | null | undefined) => Boolean(entry && propsRef.current.interactive && propsRef.current.run && !entry.installed && !propsRef.current.scenario.baseParts.includes(entry.id));
    const select = (id: string | null) => { if (selectedRef.current === id) return; selectedRef.current = id; setSelected(id); propsRef.current.onPartSelect?.(id); };

    const pick = (clientX: number, clientY: number): Entry | null => {
      const rect = canvas.getBoundingClientRect();
      ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);
      const hits = raycaster.intersectObjects(pickables, true);
      for (const hit of hits) { const id = hit.object.userData.partId as string | undefined; const entry = id ? entries.get(id) : undefined; if (entry && hit.object.visible) return entry; }
      return null;
    };

    // Resting height of a part on the bench at a given orientation.
    const restY = (entry: Entry, quat: THREE.Quaternion) => {
      const { object } = entry;
      const savedPos = object.position.clone(), savedQuat = object.quaternion.clone();
      object.position.set(0, 0, 0); object.quaternion.copy(quat); object.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(object);
      object.position.copy(savedPos); object.quaternion.copy(savedQuat); object.updateMatrixWorld(true);
      return tableY - box.min.y + radius * 0.002;
    };

    const layout = () => {
      const s = propsRef.current.scenario;
      const box = new THREE.Box3();
      for (const entry of entries.values()) {
        entry.object.position.set(...entry.part.assembled.position); entry.object.quaternion.set(...entry.part.assembled.quaternion); entry.object.updateMatrixWorld(true);
        box.expandByObject(entry.object);
      }
      if (box.isEmpty()) box.set(new THREE.Vector3(-0.05, 0, -0.05), new THREE.Vector3(0.05, 0.05, 0.05));
      box.getCenter(center);
      const size = box.getSize(tmp);
      radius = Math.max(0.04, Math.hypot(size.x, size.z) / 2, size.y / 2);
      tableY = box.min.y;
      const order = new Map<string, number>();
      s.steps.forEach((step, index) => step.partIds.forEach((id) => { if (!order.has(id)) order.set(id, index); }));
      const loose = [...entries.values()].filter((entry) => !s.baseParts.includes(entry.id)).sort((a, b) => (order.get(a.id) ?? 999) - (order.get(b.id) ?? 999));
      const maxPart = Math.max(0.01, ...loose.map((entry) => entry.radius));
      const needed = loose.reduce((sum, entry) => sum + entry.radius * 2.3, 0);
      const ringR = Math.max(Math.hypot(size.x, size.z) / 2 + maxPart * 1.3 + radius * 0.2, needed / (Math.PI * 2));
      const step = (Math.PI * 2) / Math.max(loose.length, 1);
      loose.forEach((entry, k) => {
        const angle = (k % 2 ? 1 : -1) * Math.ceil(k / 2) * step; // next parts sit at the front, alternating left/right
        const quat = new THREE.Quaternion(...entry.part.assembled.quaternion);
        if (propsRef.current.scrambleStaging) quat.premultiply(scrambleQuat(entry.id));
        const pos = new THREE.Vector3(center.x + Math.sin(angle) * ringR, 0, center.z + Math.cos(angle) * ringR);
        pos.y = restY(entry, quat);
        entry.slot = toTransform(pos, quat);
      });
      radius = Math.max(radius, ringR + maxPart);
      buildBench(ringR);
    };

    const buildBench = (ringR: number) => {
      if (bench) { scene.remove(bench); bench.traverse((child) => { if (child instanceof THREE.Mesh || child instanceof THREE.LineSegments) { child.geometry.dispose(); (child.material as THREE.Material).dispose(); } }); }
      bench = new THREE.Group();
      if (!transparent) {
        const texture = tableTexture();
        const table = new THREE.Mesh(new THREE.CircleGeometry(radius * 3.2, 64), new THREE.MeshStandardMaterial({ map: texture, transparent: true, roughness: 0.92, metalness: 0.05, depthWrite: false }));
        table.rotation.x = -Math.PI / 2; table.position.set(center.x, tableY - radius * 0.004, center.z); table.receiveShadow = true; bench.add(table);
        const shadow = new THREE.Mesh(new THREE.CircleGeometry(radius * 3, 64), new THREE.ShadowMaterial({ opacity: 0.45 }));
        shadow.rotation.x = -Math.PI / 2; shadow.position.set(center.x, tableY - radius * 0.003, center.z); shadow.receiveShadow = true; bench.add(shadow);
        const cell = niceStep(radius / 6), span = Math.ceil((radius * 4) / cell) * cell;
        const grid = new THREE.GridHelper(span, Math.round(span / cell), "#2a3a4a", "#1a2430");
        grid.position.set(center.x, tableY - radius * 0.002, center.z);
        (grid.material as THREE.Material).transparent = true; (grid.material as THREE.Material).opacity = 0.55; (grid.material as THREE.Material).depthWrite = false;
        bench.add(grid);
      }
      const ringMesh = new THREE.Mesh(new THREE.RingGeometry(ringR - radius * 0.006, ringR + radius * 0.006, 128), new THREE.MeshBasicMaterial({ color: "#38d9f5", transparent: true, opacity: transparent ? 0.35 : 0.22, side: THREE.DoubleSide, depthWrite: false }));
      ringMesh.rotation.x = -Math.PI / 2; ringMesh.position.set(center.x, tableY - radius * 0.001, center.z); bench.add(ringMesh);
      const crossMat = new THREE.MeshBasicMaterial({ color: "#ffb547", transparent: true, opacity: 0.5, depthWrite: false });
      for (const rot of [0, Math.PI / 2]) { const bar = new THREE.Mesh(new THREE.PlaneGeometry(radius * 0.18, radius * 0.008), crossMat.clone()); bar.rotation.set(-Math.PI / 2, 0, rot); bar.position.set(center.x, tableY - radius * 0.0005, center.z); bench.add(bar); }
      crossMat.dispose();
      scene.add(bench);
      shadowDirty = true;
      key.position.set(center.x + radius * 1.6, tableY + radius * 3.2, center.z + radius * 1.2); key.target.position.copy(center);
      const cam = key.shadow.camera; cam.left = cam.bottom = -radius * 1.6; cam.right = cam.top = radius * 1.6; cam.near = radius * 0.1; cam.far = radius * 8; cam.updateProjectionMatrix();
      key.shadow.bias = -0.0004; key.shadow.normalBias = radius * 0.004;
      rim.position.set(center.x - radius * 2, tableY + radius * 1.5, center.z - radius * 2.2);
      fill.position.set(center.x - radius * 1.5, tableY + radius * 0.6, center.z + radius * 2);
      camera.near = radius * 0.01; camera.far = radius * 40; camera.updateProjectionMatrix();
      controls.minDistance = radius * 0.15; controls.maxDistance = radius * 10;
    };

    const frame = (animate = true) => {
      const box = new THREE.Box3();
      for (const entry of entries.values()) { entry.object.updateMatrixWorld(true); box.expandByObject(entry.object); }
      if (box.isEmpty()) return;
      const sphere = box.getBoundingSphere(new THREE.Sphere());
      const vFov = THREE.MathUtils.degToRad(camera.fov) / 2, hFov = Math.atan(Math.tan(vFov) * camera.aspect);
      const distance = (sphere.radius / Math.sin(Math.min(vFov, hFov))) * 0.8; // the bench ring is flat, so the sphere over-estimates
      const dir = new THREE.Vector3(0.5, 0.62, 1).normalize();
      const toTarget = sphere.center.clone(); toTarget.y = Math.max(toTarget.y - sphere.radius * 0.12, tableY);
      const toPos = toTarget.clone().addScaledVector(dir, distance);
      if (!animate) { camera.position.copy(toPos); controls.target.copy(toTarget); controls.update(); return; }
      tween = { fromPos: camera.position.clone(), toPos, fromTarget: controls.target.clone(), toTarget, start: performance.now(), duration: 700 };
    };

    const sync = (animate: boolean) => {
      const p = propsRef.current, s = p.scenario, r = p.run;
      for (const entry of entries.values()) {
        const part = s.parts.find((item) => item.id === entry.id); if (!part) continue;
        entry.part = part;
        entry.installed = !r || r.installed.includes(entry.id);
        let t: Transform;
        if (!r) t = p.exploded ? stagingPose(s, entry.id) : part.assembled;
        else if (entry.installed) t = part.assembled;
        else t = entry.userPose ?? entry.slot ?? stagingPose(s, entry.id);
        entry.targetPos.set(...t.position); entry.targetQuat.set(...t.quaternion);
        if (!animate && drag?.entry !== entry) { entry.object.position.copy(entry.targetPos); entry.object.quaternion.copy(entry.targetQuat); }
        entry.ghost.position.set(...part.assembled.position); entry.ghost.quaternion.set(...part.assembled.quaternion);
      }
    };

    const rotate = (axis: "x" | "y" | "z", dir = 1) => {
      const entry = selectedRef.current ? entries.get(selectedRef.current) : undefined;
      if (!entry || !draggable(entry)) return;
      const q = new THREE.Quaternion().setFromAxisAngle(AXES[axis], (dir * Math.PI) / 2);
      if (drag?.entry === entry) { entry.object.quaternion.premultiply(q); return; }
      const quat = entry.targetQuat.clone().premultiply(q);
      const pos = entry.targetPos.clone();
      const resting = Math.abs(pos.y - restY(entry, entry.targetQuat)) < radius * 0.02;
      const rest = restY(entry, quat);
      pos.y = resting ? rest : Math.max(pos.y, rest);
      entry.userPose = toTransform(pos, quat);
      entry.targetPos.copy(pos); entry.targetQuat.copy(quat);
    };

    // ---- pointer interaction (registered before OrbitControls so a part grab can disable orbiting) ----
    const label = (text: string | null, x = 0, y = 0, kind = "") => {
      const node = labelRef.current; if (!node) return;
      if (!text) { node.style.opacity = "0"; return; }
      const rect = canvas.getBoundingClientRect();
      node.textContent = text; node.dataset.kind = kind; node.style.opacity = "1";
      node.style.transform = `translate(${x - rect.left + 14}px, ${y - rect.top - 30}px)`;
    };

    const snapRadius = (entry: Entry) => Math.max(entry.part.mate.positionTolerance * 3, radius * 0.06);
    const pushDepth = (amount: number) => {
      if (!drag) return;
      camera.getWorldDirection(forward);
      drag.raw.addScaledVector(forward, amount);
      drag.plane.constant -= amount;
      updateSnap();
    };

    // Magnetic preview: near its seat in 3D, or when the part lines up with its seat on screen (so depth is forgiving
    // with a mouse), the part is pulled toward the seat and released exactly there. The engine still judges the drop
    // (order and orientation), so snapping never makes a wrong placement right.
    // Pixel distance from the seat to the nearer of the part origin and the pointer, on screen.
    const screenGap = (part: THREE.Vector3, seat: THREE.Vector3, pointerX: number, pointerY: number) => {
      const rect = canvas.getBoundingClientRect();
      const toPx = (v: THREE.Vector3) => { const p = tmp.copy(v).project(camera); return [rect.left + ((p.x + 1) * rect.width) / 2, rect.top + ((1 - p.y) * rect.height) / 2]; };
      const [sx, sy] = toPx(seat), [px, py] = toPx(part);
      return Math.min(Math.hypot(px - sx, py - sy), Math.hypot(pointerX - sx, pointerY - sy));
    };
    const updateSnap = () => {
      if (!drag) return;
      const { entry, raw } = drag;
      if (raw.y < tableY) raw.y = tableY;
      const seat = tmp2.set(...entry.part.assembled.position);
      drag.snapping = raw.distanceTo(seat) < snapRadius(entry) || screenGap(raw, seat, drag.lastX, drag.lastY) < 34;
      entry.object.position.copy(raw);
      if (drag.snapping) entry.object.position.lerp(seat, 0.8);
    };

    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType === "touch") touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (drag && event.pointerId !== drag.pointerId) { drag.depthPointer = event.pointerId; drag.depthY = event.clientY; return; }
      if ((event.button !== 0 && event.pointerType === "mouse") || touches.size > 1) { pendingClick = null; return; }
      const entry = pick(event.clientX, event.clientY);
      if (!entry) { pendingClick = { x: event.clientX, y: event.clientY }; return; }
      pendingClick = null;
      select(entry.id);
      if (!draggable(entry)) return;
      controls.enabled = false;
      canvas.setPointerCapture(event.pointerId);
      const hit = raycaster.intersectObject(entry.object, true)[0]?.point ?? entry.object.position.clone();
      camera.getWorldDirection(forward);
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(forward.clone(), hit);
      drag = { entry, pointerId: event.pointerId, plane, offset: entry.object.position.clone().sub(hit), raw: entry.object.position.clone(), startX: event.clientX, startY: event.clientY, lastX: event.clientX, lastY: event.clientY, moved: false, depthPointer: null, depthY: 0, snapping: false };
      canvas.style.cursor = "grabbing";
    };

    const onPointerMove = (event: PointerEvent) => {
      if (touches.has(event.pointerId)) touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (drag) {
        if (event.pointerId === drag.depthPointer) { pushDepth((event.clientY - drag.depthY) * radius * 0.006); drag.depthY = event.clientY; return; }
        if (event.pointerId !== drag.pointerId) return;
        if (!drag.moved && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 4) drag.moved = true;
        if (!drag.moved) return;
        if (event.shiftKey) pushDepth((event.clientY - drag.lastY) * radius * 0.006);
        else {
          const rect = canvas.getBoundingClientRect();
          ndc.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
          raycaster.setFromCamera(ndc, camera);
          if (raycaster.ray.intersectPlane(drag.plane, tmp)) drag.raw.copy(tmp.add(drag.offset));
          drag.lastX = event.clientX; drag.lastY = event.clientY;
          updateSnap();
        }
        drag.lastY = event.clientY;
        label(drag.snapping ? `Release to seat ${drag.entry.part.name}` : drag.entry.part.name, event.clientX, event.clientY, drag.snapping ? "snap" : "drag");
        return;
      }
      if (event.pointerType !== "mouse" || event.buttons) return;
      const entry = pick(event.clientX, event.clientY);
      hovered = entry?.id ?? null;
      canvas.style.cursor = entry ? (draggable(entry) ? "grab" : "pointer") : "default";
      label(entry ? `${entry.part.name}${entry.installed ? " · installed" : ""}` : null, event.clientX, event.clientY, entry?.installed ? "done" : "");
    };

    const onPointerUp = (event: PointerEvent) => {
      touches.delete(event.pointerId);
      if (drag && event.pointerId === drag.depthPointer) { drag.depthPointer = null; return; }
      if (drag && event.pointerId === drag.pointerId) {
        const current = drag; drag = null;
        controls.enabled = true;
        canvas.style.cursor = "grab";
        if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
        label(null);
        if (!current.moved) return;
        const { entry } = current;
        const position = current.snapping ? new THREE.Vector3(...entry.part.assembled.position) : entry.object.position.clone();
        const pose = toTransform(position, entry.object.quaternion);
        entry.userPose = pose; entry.targetPos.copy(position); entry.targetQuat.copy(entry.object.quaternion);
        propsRef.current.onPartDrop?.(entry.id, pose);
        return;
      }
      if (pendingClick && Math.hypot(event.clientX - pendingClick.x, event.clientY - pendingClick.y) < 5) select(null);
      pendingClick = null;
    };

    const onWheel = (event: WheelEvent) => {
      if (!drag) return;
      event.preventDefault(); event.stopImmediatePropagation();
      pushDepth(Math.sign(event.deltaY) * radius * 0.04);
    };
    const onLeave = () => { hovered = null; if (!drag) label(null); };

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerUp);
    canvas.addEventListener("pointerleave", onLeave);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true; controls.dampingFactor = 0.08; controls.maxPolarAngle = Math.PI * 0.49;

    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable)) return;
      if (!propsRef.current.interactive) return;
      const keyName = event.key.toLowerCase();
      const axis = keyName === "r" ? "x" : keyName === "t" ? "y" : keyName === "y" ? "z" : null;
      if (axis) { rotate(axis, event.shiftKey ? -1 : 1); event.preventDefault(); }
      else if (keyName === "f") frame();
      else if (keyName === "escape") select(null);
    };
    window.addEventListener("keydown", onKey);

    const observer = new ResizeObserver(() => {
      const w = Math.max(el.clientWidth, 1), h = Math.max(el.clientHeight, 1);
      renderer.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix();
    });
    observer.observe(el);

    // ---- per-frame update ----
    const clock = new THREE.Clock();
    renderer.setAnimationLoop(() => {
      const dt = Math.min(clock.getDelta(), 0.05), now = performance.now(), t = now / 1000;
      const k = 1 - Math.exp(-dt * 11);
      const p = propsRef.current;
      const highlights = p.highlightPartIds ?? EMPTY, ghosts = p.ghostPartIds ?? EMPTY;
      // Adaptive resolution: sustained slow frames step the pixel ratio down (keeps ~60 fps on weak GPUs).
      frameTime = frameTime * 0.95 + dt * 1000 * 0.05;
      if (frameTime > 24 && pixelRatio > 0.75 && ++slowFrames > 90) { pixelRatio = Math.max(0.75, pixelRatio - 0.25); renderer.setPixelRatio(pixelRatio); renderer.setSize(Math.max(el.clientWidth, 1), Math.max(el.clientHeight, 1)); slowFrames = 0; frameTime = 16; }
      let moving = Boolean(drag);
      for (const entry of entries.values()) {
        const dragging = drag?.entry === entry;
        if (!dragging) {
          if (entry.object.position.distanceToSquared(entry.targetPos) > 1e-12) { entry.object.position.lerp(entry.targetPos, k); moving = true; }
          if (entry.object.quaternion.angleTo(entry.targetQuat) > 1e-4) { entry.object.quaternion.slerp(entry.targetQuat, k); moving = true; }
        }
        // Emissive state: flash > selected > highlight > hover > base.
        let color: THREE.Color | null = null, intensity = 0;
        if (entry.flash) {
          const progress = (now - entry.flash.start) / entry.flash.duration;
          if (progress >= 1) entry.flash = null;
          else { color = entry.flash.color; intensity = (1 - progress) * 0.9 * (0.55 + 0.45 * Math.cos(progress * Math.PI * 6)); }
        }
        if (!color && selectedRef.current === entry.id && !entry.installed) { color = COLORS.amber; intensity = 0.32 + 0.1 * Math.sin(t * 5); }
        else if (!color && highlights.includes(entry.id)) { color = COLORS.cyan; intensity = 0.22 + 0.12 * Math.sin(t * 3.2); }
        else if (!color && hovered === entry.id) { color = COLORS.amber; intensity = 0.16; }
        for (const material of entry.materials) {
          if (color) { material.emissive.copy(color); material.emissiveIntensity = intensity; }
          else { material.emissive.copy(material.userData.baseEmissive ?? COLORS.black); material.emissiveIntensity = material.userData.baseEmissiveIntensity ?? 1; }
        }
        const snapPreview = dragging && drag!.snapping;
        const showGhost = snapPreview || (p.run ? !entry.installed && ghosts.includes(entry.id) : ghosts.includes(entry.id));
        entry.ghost.visible = showGhost;
        if (showGhost) {
          if (snapPreview) {
            const angle = orientationError(toTransform(entry.object.position, entry.object.quaternion).quaternion, entry.part.assembled.quaternion, entry.part.mate);
            const good = angle <= entry.part.mate.angleToleranceDeg;
            entry.ghostMaterial.color.copy(good ? COLORS.green : COLORS.amber); entry.ghostMaterial.emissive.copy(good ? COLORS.green : COLORS.amber);
            entry.ghostMaterial.opacity = 0.42 + 0.12 * Math.sin(t * 10);
          } else {
            entry.ghostMaterial.color.copy(COLORS.cyan); entry.ghostMaterial.emissive.copy(COLORS.cyan);
            entry.ghostMaterial.opacity = 0.16 + 0.1 * Math.sin(t * 3.5);
          }
        }
      }
      if (tween) {
        const progress = Math.min(1, (now - tween.start) / tween.duration), e = 1 - (1 - progress) ** 3;
        camera.position.lerpVectors(tween.fromPos, tween.toPos, e); controls.target.lerpVectors(tween.fromTarget, tween.toTarget, e);
        if (progress >= 1) tween = null;
      }
      controls.update();
      if (moving || shadowDirty) { renderer.shadowMap.needsUpdate = true; shadowDirty = false; }
      renderer.render(scene, camera);
    });

    // ---- load parts ----
    const ghostTemplate = new THREE.MeshStandardMaterial({ color: COLORS.cyan, emissive: COLORS.cyan, emissiveIntensity: 0.8, transparent: true, opacity: 0.25, depthWrite: false, roughness: 0.4, metalness: 0 });
    const initial = propsRef.current.scenario;
    void Promise.all(initial.parts.map(async (part) => ({ part, object: await buildPartObject(part) }))).then((built) => {
      if (disposed) { for (const { object } of built) object.traverse((child) => { if (child instanceof THREE.Mesh) { child.geometry.dispose(); (Array.isArray(child.material) ? child.material : [child.material]).forEach((m) => m.dispose()); } }); return; }
      for (const { part, object } of built) {
        const materials: THREE.MeshStandardMaterial[] = [];
        object.traverse((child) => { if (child instanceof THREE.Mesh) for (const m of Array.isArray(child.material) ? child.material : [child.material]) if (m instanceof THREE.MeshStandardMaterial && !materials.includes(m)) materials.push(m); });
        const ghostMaterial = ghostTemplate.clone();
        const ghost = object.clone(true);
        ghost.traverse((child) => { child.userData = {}; if (child instanceof THREE.Mesh) { child.material = ghostMaterial; child.castShadow = false; child.receiveShadow = false; child.renderOrder = 2; } });
        ghost.visible = false;
        const sphere = new THREE.Box3().setFromObject(object).getBoundingSphere(new THREE.Sphere());
        const entry: Entry = { id: part.id, part, object, ghost, ghostMaterial, materials, targetPos: new THREE.Vector3(), targetQuat: new THREE.Quaternion(), slot: null, userPose: null, installed: true, radius: Math.max(sphere.radius, 0.004), flash: null };
        entries.set(part.id, entry);
        pickables.push(object);
        scene.add(object, ghost);
      }
      layout();
      sync(false);
      frame(false);
      setReady(true);
    });

    ctxRef.current = { sync, rotate, frame: () => frame(true), entries };
    return () => {
      disposed = true;
      ctxRef.current = null;
      renderer.setAnimationLoop(null);
      observer.disconnect();
      window.removeEventListener("keydown", onKey);
      canvas.removeEventListener("pointerdown", onPointerDown); canvas.removeEventListener("pointermove", onPointerMove); canvas.removeEventListener("pointerup", onPointerUp); canvas.removeEventListener("pointercancel", onPointerUp); canvas.removeEventListener("pointerleave", onLeave); canvas.removeEventListener("wheel", onWheel);
      controls.dispose();
      const geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>();
      scene.traverse((child) => { if (child instanceof THREE.Mesh || child instanceof THREE.LineSegments) { geometries.add(child.geometry); (Array.isArray(child.material) ? child.material : [child.material]).forEach((m: THREE.Material) => materials.add(m)); } });
      geometries.forEach((g) => g.dispose());
      materials.forEach((m) => { const map = (m as THREE.MeshStandardMaterial).map; map?.dispose(); m.dispose(); });
      ghostTemplate.dispose(); envTexture.dispose(); pmrem.dispose(); renderer.dispose();
      if (canvas.parentElement === el) el.removeChild(canvas);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [partsKey, transparentBackground]);

  // Incremental pose updates + success/mistake effects on run changes.
  const prevRun = useRef<RunState | null | undefined>(undefined);
  useEffect(() => {
    const ctx = ctxRef.current;
    const prev = prevRun.current; prevRun.current = run;
    if (!ctx) return;
    const now = performance.now();
    const flash = (ids: string[], color: THREE.Color, duration: number) => ids.forEach((id) => { const entry = ctx.entries.get(id); if (entry) entry.flash = { color, start: now, duration }; });
    if (run && prev && run !== prev) {
      const restarted = run.startedAt !== prev.startedAt || run.completed.length < prev.completed.length || run.mistakes.length < prev.mistakes.length;
      if (restarted) for (const entry of ctx.entries.values()) entry.userPose = null;
      else {
        const added = run.installed.filter((id) => !prev.installed.includes(id));
        added.forEach((id) => { const entry = ctx.entries.get(id); if (entry) entry.userPose = null; });
        flash(added, COLORS.green, 1100);
        const finished = run.completed.filter((id) => !prev.completed.includes(id));
        flash(finished.flatMap((id) => scenario.steps.find((step) => step.id === id)?.partIds ?? []).filter((id) => !added.includes(id)), COLORS.green, 1100);
        for (const mistake of run.mistakes.slice(prev.mistakes.length)) {
          const ids = mistake.partId ? [mistake.partId] : scenario.steps.find((step) => step.id === mistake.stepId)?.partIds ?? [];
          flash(ids, COLORS.red, 900);
          if (mistake.partId && (mistake.reason === "out-of-order" || mistake.reason === "wrong-part")) {
            const entry = ctx.entries.get(mistake.partId);
            if (entry && !entry.installed) setTimeout(() => { entry.userPose = null; ctxRef.current?.sync(true); }, 650);
          }
        }
      }
    }
    ctx.sync(Boolean(prev !== undefined));
  }, [run, exploded, scenario, ready]);

  const canRotate = Boolean(selected && run && interactive && !run.installed.includes(selected) && !scenario.baseParts.includes(selected));
  const selectedName = selected ? scenario.parts.find((part) => part.id === selected)?.name : null;
  return (
    <div className={`forge-scene${className ? ` ${className}` : ""}`} style={{ position: "relative", width: "100%", height: "100%", minHeight: 320, overflow: "hidden" }}>
      <div ref={host} style={{ position: "absolute", inset: 0 }} />
      <div ref={labelRef} className="forge-scene-label" style={{ position: "absolute", left: 0, top: 0, opacity: 0, pointerEvents: "none" }} />
      {!ready && <div className="forge-scene-loading">Loading parts…</div>}
      {showControls && (
        <div className="forge-scene-tools" onPointerDown={(event) => event.stopPropagation()}>
          <span className="forge-scene-tools-label">{canRotate ? selectedName : "Select a part"}</span>
          {(["x", "y", "z"] as const).map((axis, i) => (
            <button key={axis} type="button" disabled={!canRotate} title={`Rotate 90° about ${axis.toUpperCase()} (${"RTY"[i]}, shift reverses)`} onClick={(event) => ctxRef.current?.rotate(axis, event.shiftKey ? -1 : 1)}>
              ⟳ {axis.toUpperCase()}<kbd>{"RTY"[i]}</kbd>
            </button>
          ))}
          <button type="button" title="Frame the workbench (F)" onClick={() => ctxRef.current?.frame()}>⛶<kbd>F</kbd></button>
        </div>
      )}
      {interactive && <div className="forge-scene-help">Drag a part · Shift-drag, wheel or second finger = depth · R/T/Y rotate · orbit on empty space</div>}
    </div>
  );
}
