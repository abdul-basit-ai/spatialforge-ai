"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { RunState } from "@/lib/forge/engine";
import { stagingPose } from "@/lib/forge/engine";
import { applyTransform, buildPartObject } from "@/lib/forge/three-parts";
import type { ForgeScenario, Transform } from "@/lib/forge/types";

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
};

export default function ForgeScene({ scenario, run, exploded, highlightPartIds = [], ghostPartIds = [], transparentBackground, className }: ForgeSceneProps) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = host.current; if (!el) return;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: Boolean(transparentBackground) });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(el.clientWidth, el.clientHeight);
    el.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    if (!transparentBackground) scene.background = new THREE.Color("#0b1220");
    scene.add(new THREE.HemisphereLight("#ffffff", "#334155", 1.4));
    const sun = new THREE.DirectionalLight("#ffffff", 1.2); sun.position.set(1, 2, 1.5); scene.add(sun);
    const camera = new THREE.PerspectiveCamera(45, el.clientWidth / Math.max(el.clientHeight, 1), 0.001, 100);
    camera.position.set(0.35, 0.3, 0.45);
    const controls = new OrbitControls(camera, renderer.domElement);
    let disposed = false;
    void Promise.all(scenario.parts.map(async (part) => {
      const object = await buildPartObject(part);
      if (disposed) return;
      const installed = !run || run.installed.includes(part.id);
      applyTransform(object, installed && !exploded ? part.assembled : stagingPose(scenario, part.id));
      if (highlightPartIds.includes(part.id)) object.scale.multiplyScalar(1.05);
      scene.add(object);
      if (ghostPartIds.includes(part.id)) {
        const ghost = object.clone(true);
        ghost.traverse((child) => { if (child instanceof THREE.Mesh) child.material = new THREE.MeshBasicMaterial({ color: "#38bdf8", transparent: true, opacity: 0.3 }); });
        applyTransform(ghost, part.assembled); scene.add(ghost);
      }
    })).then(() => {
      const box = new THREE.Box3().setFromObject(scene); const center = box.getCenter(new THREE.Vector3()); const size = box.getSize(new THREE.Vector3()).length() || 0.3;
      controls.target.copy(center); camera.position.copy(center).add(new THREE.Vector3(size * 0.8, size * 0.6, size));
    });
    const onResize = () => { renderer.setSize(el.clientWidth, el.clientHeight); camera.aspect = el.clientWidth / Math.max(el.clientHeight, 1); camera.updateProjectionMatrix(); };
    window.addEventListener("resize", onResize);
    renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); });
    return () => { disposed = true; window.removeEventListener("resize", onResize); renderer.setAnimationLoop(null); renderer.dispose(); el.removeChild(renderer.domElement); };
  }, [scenario, run, exploded, highlightPartIds, ghostPartIds, transparentBackground]);
  return <div ref={host} className={className} style={{ width: "100%", height: "100%", minHeight: 320 }} />;
}
