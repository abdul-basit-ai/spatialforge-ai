"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { getScenario, sceneLayout, screenToWorld, type PartDefinition, type PartId, type Point, type ScenarioId } from "@/lib/assembly";

type Props = { scenario: ScenarioId; current: PartId | null; completed: PartId[]; dragged: Point | null; ready: boolean; warningSlot: PartId | null; rotations: Record<string, number> };
type Runtime = Props;
type VisualPart = { id: PartId; group: THREE.Group; target: THREE.Vector3 };

const COLORS = [0x80dfff, 0xffbd70, 0xc4f48e, 0xc5a6ff, 0xd8e2e5, 0xf2a5c2, 0xf0c878, 0x8fd8c5];

export function ThreeWorkbench(props: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef<Runtime>(props);
  runtimeRef.current = props;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let renderer: THREE.WebGLRenderer;
    try { renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: "high-performance" }); }
    catch { host.textContent = "3D preview is unavailable on this browser. Touch controls remain available."; return; }
    renderer.setClearColor(0x000000, 0); renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2)); renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.55; renderer.shadowMap.enabled = true; renderer.domElement.className = "three-canvas"; host.appendChild(renderer.domElement);
    const definition = getScenario(props.scenario); const scene = new THREE.Scene(); const camera = new THREE.OrthographicCamera(-4, 4, 4, -4, 0.1, 100); camera.position.set(0, 0.7, 12); camera.lookAt(0, 0, 0);
    scene.add(new THREE.HemisphereLight(0xe9fff8, 0x07100d, 2.2)); const key = new THREE.DirectionalLight(0xffffff, 4.2); key.position.set(-4, 6, 9); key.castShadow = true; scene.add(key); const rim = new THREE.PointLight(0x69e8ff, 90, 20); rim.position.set(4, -1, 5); scene.add(rim);
    const runtime = props.scenario === "pneumatic" ? createPneumaticScene(scene, definition.parts) : createTrayScene(scene, definition.parts, props.scenario);
    let layout = sceneLayout(host.clientWidth, host.clientHeight, props.scenario); let animationFrame = 0;
    const resize = () => { const width = Math.max(host.clientWidth, 1); const height = Math.max(host.clientHeight, 1); layout = sceneLayout(width, height, props.scenario); camera.left = -layout.viewWidth / 2; camera.right = layout.viewWidth / 2; camera.top = layout.viewHeight / 2; camera.bottom = -layout.viewHeight / 2; camera.updateProjectionMatrix(); renderer.setSize(width, height, false); runtime.resize(layout); };
    const observer = new ResizeObserver(resize); observer.observe(host); resize();
    const animate = (time: number) => { animationFrame = requestAnimationFrame(animate); runtime.update(runtimeRef.current, layout, time); renderer.render(scene, camera); };
    animationFrame = requestAnimationFrame(animate);
    return () => { cancelAnimationFrame(animationFrame); observer.disconnect(); scene.traverse((object) => { if (object instanceof THREE.Mesh || object instanceof THREE.LineSegments) { object.geometry.dispose(); const materials = Array.isArray(object.material) ? object.material : [object.material]; materials.forEach((item) => item.dispose()); } }); renderer.dispose(); if (host.contains(renderer.domElement)) host.removeChild(renderer.domElement); };
  }, [props.scenario]);
  return <div ref={hostRef} className="three-host" aria-label={`${props.scenario} 3D assembly workbench`} />;
}

function createPneumaticScene(scene: THREE.Scene, definitions: readonly PartDefinition[]) {
  const productRoot = new THREE.Group(); scene.add(productRoot);
  const bench = new THREE.Mesh(new THREE.BoxGeometry(7.1, 5.25, 0.16), new THREE.MeshStandardMaterial({ color: 0x0b1c19, metalness: 0.35, roughness: 0.62 })); bench.position.set(0, -0.22, -0.75); bench.receiveShadow = true; scene.add(bench);
  const rail = new THREE.Mesh(new THREE.BoxGeometry(6.6, 1.25, 0.13), new THREE.MeshStandardMaterial({ color: 0x172b27, metalness: 0.48, roughness: 0.42 })); rail.position.set(0, -2.95, -0.52); scene.add(rail);
  const fixtureMaterial = new THREE.MeshStandardMaterial({ color: 0x102b29, metalness: 0.55, roughness: 0.36 }); const fixture = new THREE.Mesh(new THREE.BoxGeometry(4.65, 2.45, 0.18), fixtureMaterial); fixture.position.set(0.25, 0.55, -0.62); scene.add(fixture);
  const targets: Record<string, THREE.Vector3> = { P1: new THREE.Vector3(-0.25, 0.42, 0.05), P2: new THREE.Vector3(-1.05, 0.42, 0.34), P3: new THREE.Vector3(-0.18, 0.42, 0.38), P4: new THREE.Vector3(0.68, 0.42, 0.38), P5: new THREE.Vector3(1.17, 0.42, 0.3), P6: new THREE.Vector3(1.68, 0.42, 0.25), P7: new THREE.Vector3(1.98, 0.42, 0.34), P8: new THREE.Vector3(-0.25, 1.34, 0.3) };
  const visuals: VisualPart[] = definitions.map((definition) => { const group = makePneumaticPart(definition.id, Number.parseInt(definition.color.slice(1), 16)); group.userData.partId = definition.id; group.traverse((object) => { object.userData.partId = definition.id; if (object instanceof THREE.Mesh) object.castShadow = true; }); productRoot.add(group); return { id: definition.id, group, target: targets[definition.id].clone() }; });
  const ghosts = definitions.map((definition) => { const group = makePneumaticPart(definition.id, 0x69f5c4, true); group.position.copy(targets[definition.id]); group.visible = false; productRoot.add(group); return group; });
  const insertionArrow = new THREE.ArrowHelper(new THREE.Vector3(-1, 0, 0), new THREE.Vector3(2.6, 0.42, 0.5), 0.7, 0xdfff86, 0.18, 0.1); insertionArrow.visible = false; productRoot.add(insertionArrow);
  return {
    resize(layout: ReturnType<typeof sceneLayout>) { bench.scale.x = Math.max(1, layout.boardWidth / 6.2); rail.scale.x = Math.max(1, layout.boardWidth / 6.2); },
    update(state: Runtime, layout: ReturnType<typeof sceneLayout>, time: number) {
      const allComplete = state.completed.length === definitions.length; const viewY = ((state.rotations.__viewY || 0) * Math.PI) / 180; productRoot.rotation.y += (viewY - productRoot.rotation.y) * 0.14; productRoot.rotation.x += ((allComplete ? -0.08 : 0) - productRoot.rotation.x) * 0.1;
      fixtureMaterial.opacity = state.current && ["P2", "P3", "P4"].includes(state.current) ? 0.32 : 1; fixtureMaterial.transparent = fixtureMaterial.opacity < 1;
      visuals.forEach((visual, index) => { const placed = state.completed.includes(visual.id); const active = state.current === visual.id; const source = layout.sources[index]; const screen = active && state.dragged ? screenToWorld(state.dragged, layout.viewWidth, layout.viewHeight) : null; const desired = placed ? visual.target : screen ? new THREE.Vector3(screen.x, screen.y, 0.9) : new THREE.Vector3(source.x, source.y, 0.12); visual.group.position.lerp(desired, active && state.dragged ? 0.42 : 0.18); const scale = placed ? 0.82 : active ? 1.03 : 0.68; visual.group.scale.lerp(new THREE.Vector3(scale, scale, scale), 0.16); visual.group.rotation.z = ((state.rotations[visual.id] || 0) * Math.PI) / 180; if (active && !state.dragged) visual.group.position.z = 0.45 + Math.sin(time * 0.003) * 0.05; ghosts[index].visible = active && !placed; ghosts[index].scale.setScalar(state.ready ? 0.91 + Math.sin(time * 0.006) * 0.04 : 0.82); });
      insertionArrow.visible = Boolean(state.current && !state.completed.includes(state.current)); if (state.current) { const target = targets[state.current]; insertionArrow.position.set(target.x + 0.9, target.y, target.z + 0.15); }
      rail.visible = !allComplete; fixture.visible = !allComplete; if (allComplete && Math.abs(viewY) < 0.001) productRoot.rotation.y = Math.sin(time * 0.00045) * 0.22;
    },
  };
}

function createTrayScene(scene: THREE.Scene, definitions: readonly PartDefinition[], scenario: ScenarioId) {
  const ids = definitions.map((part) => part.id); const board = new THREE.Group(); scene.add(board);
  const boardBase = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 0.24), new THREE.MeshStandardMaterial({ color: scenario === "valve" ? 0x1b303b : 0x143029, metalness: 0.48, roughness: 0.38 })); boardBase.position.z = -0.28; board.add(boardBase);
  const boardEdges = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 0.24)), new THREE.LineBasicMaterial({ color: 0x79d9be, transparent: true, opacity: 0.74 })); boardEdges.position.z = -0.28; board.add(boardEdges);
  const slots = definitions.map((part, index) => { const group = new THREE.Group(); const fillMaterial = new THREE.MeshStandardMaterial({ color: 0x091c18, emissive: 0x073327, emissiveIntensity: 0.2 }); const fill = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 0.045), fillMaterial); group.add(fill); const outline = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 0.05)), new THREE.LineBasicMaterial({ color: COLORS[index], transparent: true, opacity: 0.4 })); group.add(outline); const cavity = makeBasicPart(part, 0x547369, 0.19); cavity.scale.setScalar(0.7); group.add(cavity); board.add(group); return { group, fillMaterial, outline: outline.material as THREE.LineBasicMaterial }; });
  const shelf = new THREE.Mesh(new THREE.BoxGeometry(1, 0.92, 0.16), new THREE.MeshStandardMaterial({ color: 0x12312a, metalness: 0.45, roughness: 0.42 })); scene.add(shelf); const parts = definitions.map((part) => { const group = makeBasicPart(part, Number.parseInt(part.color.slice(1), 16), 1); scene.add(group); return group; });
  return {
    resize(layout: ReturnType<typeof sceneLayout>) { boardBase.scale.set(layout.boardWidth, layout.boardHeight, 1); boardEdges.scale.set(layout.boardWidth, layout.boardHeight, 1); slots.forEach(({ group }, index) => { const point = layout.worldSlots[ids[index]]; group.position.set(point.x, point.y, 0); group.children[0].scale.set(layout.boardWidth * 0.42, 1.35, 1); group.children[1].scale.set(layout.boardWidth * 0.42, 1.35, 1); }); shelf.scale.x = layout.boardWidth; shelf.position.y = layout.sources[0].y; },
    update(state: Runtime, layout: ReturnType<typeof sceneLayout>, time: number) { slots.forEach(({ fillMaterial, outline }, index) => { const id = ids[index]; const active = state.current === id; const placed = state.completed.includes(id); const warning = state.warningSlot === id; fillMaterial.emissive.setHex(warning ? 0xe08224 : active ? 0x83b632 : placed ? 0x236c5c : 0x073327); outline.color.setHex(warning ? 0xffbd70 : COLORS[index]); }); parts.forEach((part, index) => { const id = ids[index]; const placed = state.completed.includes(id); const active = state.current === id; const target = placed ? layout.worldSlots[id] : active && state.dragged ? screenToWorld(state.dragged, layout.viewWidth, layout.viewHeight) : layout.sources[index]; const speed = active && state.dragged ? 0.42 : 0.18; part.position.x += (target.x - part.position.x) * speed; part.position.y += (target.y - part.position.y) * speed; part.position.z += ((placed ? 0.24 : active && state.dragged ? 0.7 : 0.1) - part.position.z) * speed; const scale = placed ? 0.73 : active ? 1.12 : 0.8; part.scale.lerp(new THREE.Vector3(scale, scale, scale), 0.16); part.rotation.z = ((state.rotations[id] || 0) * Math.PI) / 180; if (active && !state.dragged) part.rotation.y = Math.sin(time * 0.0015) * 0.12; }); },
  };
}

function surface(color: number, ghost = false) { return new THREE.MeshStandardMaterial({ color, metalness: ghost ? 0.1 : 0.68, roughness: 0.28, transparent: ghost, opacity: ghost ? 0.22 : 1, emissive: ghost ? 0x2ad69d : 0x000000, emissiveIntensity: ghost ? 0.55 : 0 }); }
function add(group: THREE.Group, geometry: THREE.BufferGeometry, mat: THREE.Material, position: [number, number, number] = [0, 0, 0], rotation: [number, number, number] = [0, 0, 0]) { const mesh = new THREE.Mesh(geometry, mat); mesh.position.set(...position); mesh.rotation.set(...rotation); group.add(mesh); return mesh; }
function makePneumaticPart(id: PartId, color: number, ghost = false) {
  const group = new THREE.Group(); const mat = surface(color, ghost); const dark = surface(0x20292d, ghost);
  if (id === "P1") { add(group, new THREE.BoxGeometry(1.65, 0.92, 0.82), mat); add(group, new THREE.CylinderGeometry(0.31, 0.31, 0.48, 32), dark, [-0.83, 0, 0], [0, 0, Math.PI / 2]); add(group, new THREE.CylinderGeometry(0.31, 0.31, 0.48, 32), dark, [0.83, 0, 0], [0, 0, Math.PI / 2]); add(group, new THREE.CylinderGeometry(0.26, 0.26, 0.42, 32), mat, [0, 0.64, 0]); }
  else if (id === "P2") add(group, new THREE.TorusGeometry(0.34, 0.075, 14, 42), mat, [0, 0, 0], [0, Math.PI / 2, 0]);
  else if (id === "P3") { add(group, new THREE.CylinderGeometry(0.19, 0.19, 1.18, 32), mat, [0, 0, 0], [0, 0, Math.PI / 2]); for (const x of [-0.38, 0, 0.38]) add(group, new THREE.CylinderGeometry(0.29, 0.29, 0.12, 32), dark, [x, 0, 0], [0, 0, Math.PI / 2]); }
  else if (id === "P4") { const points = Array.from({ length: 65 }, (_, index) => { const t = index / 64; return new THREE.Vector3((t - 0.5) * 0.72, Math.sin(t * Math.PI * 14) * 0.22, Math.cos(t * Math.PI * 14) * 0.22); }); add(group, new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), 96, 0.035, 8, false), mat); }
  else if (id === "P5") { add(group, new THREE.CylinderGeometry(0.48, 0.48, 0.38, 6), mat, [0, 0, 0], [0, 0, Math.PI / 2]); add(group, new THREE.CylinderGeometry(0.28, 0.28, 0.44, 28), dark, [0, 0, 0], [0, 0, Math.PI / 2]); }
  else if (id === "P6") { add(group, new THREE.CylinderGeometry(0.55, 0.55, 0.58, 36), mat, [0, 0, 0], [0, 0, Math.PI / 2]); add(group, new THREE.CylinderGeometry(0.34, 0.34, 0.2, 32), dark, [0.38, 0, 0], [0, 0, Math.PI / 2]); }
  else if (id === "P7") { add(group, new THREE.TorusGeometry(0.38, 0.055, 10, 36, Math.PI * 1.55), mat, [0, 0, 0], [0, Math.PI / 2, 0]); add(group, new THREE.BoxGeometry(0.13, 0.25, 0.1), mat, [0.05, -0.38, 0]); }
  else if (id === "P8") { add(group, new THREE.CylinderGeometry(0.16, 0.16, 0.72, 24), mat); add(group, new THREE.CylinderGeometry(0.29, 0.29, 0.15, 24), dark, [0, 0.43, 0]); add(group, new THREE.BoxGeometry(0.34, 0.035, 0.07), surface(0xc6d2d4, ghost), [0, 0.51, 0]); }
  return group;
}
function makeBasicPart(part: PartDefinition, color: number, opacity: number) { const group = new THREE.Group(); const mat = new THREE.MeshStandardMaterial({ color, metalness: 0.36, roughness: 0.28, transparent: opacity < 1, opacity }); let mesh: THREE.Mesh; if (part.primitive === "cylinder") mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.63, 32), mat); else if (part.primitive === "hex") mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.41, 0.41, 0.44, 6), mat); else if (part.primitive === "cube") mesh = new THREE.Mesh(new THREE.BoxGeometry(0.67, 0.67, 0.67), mat); else mesh = new THREE.Mesh(new THREE.TorusGeometry(0.38, 0.14, 18, 44), mat); mesh.rotation.x = part.primitive === "torus" || part.primitive === "ring" ? 0.22 : 0.43; group.add(mesh); return group; }
