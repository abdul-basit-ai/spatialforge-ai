"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

// Studio preview of a freshly parsed assembly: orbit view, explode slider, hover/selection highlight.
// The group belongs to the caller (it is exported to GLB later), so its geometry is never disposed here.
type Props = { group: THREE.Group | null; explode?: number; selected?: string | null; onSelect?: (node: string | null) => void; className?: string };

export default function CadPreview({ group, explode = 0, selected = null, onSelect, className }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const state = useRef<{ explode: number; selected: string | null; onSelect?: Props["onSelect"] }>({ explode, selected, onSelect });
  state.current = { explode, selected, onSelect };

  useEffect(() => {
    const el = host.current; if (!el) return;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(el.clientWidth, el.clientHeight);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    el.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight("#dbe7f2", "#1b2430", 1.6));
    const key = new THREE.DirectionalLight("#fff3e0", 2.2); key.position.set(1.2, 2, 1.4); scene.add(key);
    const rim = new THREE.DirectionalLight("#5ee7ff", 1.1); rim.position.set(-1.5, 0.8, -1.2); scene.add(rim);
    const camera = new THREE.PerspectiveCamera(40, el.clientWidth / Math.max(el.clientHeight, 1), 0.0005, 200);
    camera.position.set(0.3, 0.25, 0.4);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true; controls.autoRotate = true; controls.autoRotateSpeed = 0.6;
    renderer.domElement.addEventListener("pointerdown", () => { controls.autoRotate = false; }, { once: true });

    const home = new Map<THREE.Object3D, THREE.Vector3>();
    let center = new THREE.Vector3(), radius = 0.2, floor = 0;
    let grid: THREE.GridHelper | null = null;
    if (group) {
      scene.add(group);
      for (const child of group.children) home.set(child, child.position.clone());
      const box = new THREE.Box3().setFromObject(group);
      center = box.getCenter(new THREE.Vector3()); radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 0.01);
      grid = new THREE.GridHelper(radius * 6, 24, "#4a3a1c", "#1f2a36"); floor = box.min.y - radius * 0.02;
      grid.position.y = floor;
      (grid.material as THREE.Material).transparent = true; (grid.material as THREE.Material).opacity = 0.45;
      scene.add(grid);
      controls.target.copy(center);
      camera.position.copy(center).add(new THREE.Vector3(radius * 1.6, radius * 1.15, radius * 2));
      camera.near = radius / 200; camera.far = radius * 200; camera.updateProjectionMatrix();
    }

    const raycaster = new THREE.Raycaster(), pointer = new THREE.Vector2();
    let hovered: string | null = null;
    const pick = (event: PointerEvent) => {
      if (!group) return null;
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObject(group, true)[0];
      let object: THREE.Object3D | null = hit?.object ?? null;
      while (object && object.parent !== group) object = object.parent;
      return object?.name ?? null;
    };
    const onMove = (event: PointerEvent) => { hovered = pick(event); renderer.domElement.style.cursor = hovered ? "pointer" : "grab"; };
    let down = { x: 0, y: 0 };
    const onDown = (event: PointerEvent) => { down = { x: event.clientX, y: event.clientY }; };
    const onUp = (event: PointerEvent) => { if (Math.hypot(event.clientX - down.x, event.clientY - down.y) < 4) state.current.onSelect?.(pick(event)); };
    renderer.domElement.addEventListener("pointermove", onMove);
    renderer.domElement.addEventListener("pointerdown", onDown);
    renderer.domElement.addEventListener("pointerup", onUp);

    const glow = new THREE.Color("#5ee7ff"), warm = new THREE.Color("#ffb547"), none = new THREE.Color(0);
    renderer.setAnimationLoop(() => {
      const { explode: amount, selected: sel } = state.current;
      if (grid) grid.position.y += (floor - amount * radius * 0.9 - grid.position.y) * 0.18; // keep the floor under exploded parts
      for (const [child, base] of home) {
        const target = base.clone().add(base.clone().sub(center).multiplyScalar(amount * 1.4));
        child.position.lerp(target, 0.18);
        child.traverse((object) => {
          const material = (object as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
          if (material?.emissive) material.emissive.copy(child.name === sel ? glow : child.name === hovered ? warm : none).multiplyScalar(child.name === sel ? 0.55 : 0.25);
        });
      }
      controls.update();
      renderer.render(scene, camera);
    });
    const observer = new ResizeObserver(() => { renderer.setSize(el.clientWidth, el.clientHeight); camera.aspect = el.clientWidth / Math.max(el.clientHeight, 1); camera.updateProjectionMatrix(); });
    observer.observe(el);
    return () => {
      observer.disconnect(); renderer.setAnimationLoop(null);
      for (const [child, base] of home) { child.position.copy(base); child.traverse((object) => { const m = (object as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined; m?.emissive?.set(0); }); }
      if (group) scene.remove(group);
      controls.dispose(); renderer.dispose(); el.removeChild(renderer.domElement);
    };
  }, [group]);

  return <div ref={host} className={className} style={{ width: "100%", height: "100%", minHeight: 280 }} />;
}
