"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { detectCapabilities } from "@/lib/spatial-engine";

type Props = { onStatus?: (status: string) => void };

export function MarkerlessAR({ onStatus }: Props) {
  const [supported, setSupported] = useState(false);
  const [active, setActive] = useState(false);
  const [placed, setPlaced] = useState(false);
  const hostRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<XRSession | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);

  useEffect(() => { detectCapabilities().then((report) => setSupported(report.immersiveAr)); }, []);
  useEffect(() => () => { sessionRef.current?.end().catch(() => undefined); rendererRef.current?.dispose(); }, []);

  const start = async () => {
    const xr = (navigator as Navigator & { xr?: XRSystem }).xr;
    if (!xr || !hostRef.current) return;
    try {
      const session = await xr.requestSession("immersive-ar", { requiredFeatures: ["hit-test"], optionalFeatures: ["anchors", "dom-overlay"], domOverlay: { root: hostRef.current } } as XRSessionInit);
      const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
      renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
      renderer.xr.enabled = true;
      renderer.xr.setReferenceSpaceType("local-floor");
      renderer.setAnimationLoop((time, frame) => {
        if (!frame) return;
        const ref = renderer.xr.getReferenceSpace();
        const source = frame.session.inputSources[0];
        if (ref && source) {
          const hitTestSource = (session as XRSession & { __spatialforgeHit?: XRHitTestSource }).__spatialforgeHit;
          const hits = hitTestSource ? frame.getHitTestResults(hitTestSource) : [];
          if (hits.length && !placed) {
            const pose = hits[0].getPose(ref);
            if (pose) { reticle.visible = true; reticle.position.set(pose.transform.position.x, pose.transform.position.y, pose.transform.position.z); reticle.quaternion.set(pose.transform.orientation.x, pose.transform.orientation.y, pose.transform.orientation.z, pose.transform.orientation.w); }
            onStatus?.("Surface detected · tap to place workbench");
          }
        }
        renderer.render(scene, camera);
        void time;
      });
      hostRef.current.appendChild(renderer.domElement);
      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera();
      scene.add(new THREE.HemisphereLight(0xffffff, 0x334455, 2));
      const board = new THREE.Mesh(new THREE.BoxGeometry(0.48, 0.28, 0.035), new THREE.MeshStandardMaterial({ color: 0x173a35, metalness: 0.4, roughness: 0.45 }));
      board.position.z = -0.02;
      const root = new THREE.Group(); root.visible = false; root.add(board);
      const colors = [0x80dfff, 0xffbd70, 0xc4f48e, 0xc5a6ff];
      [-0.12, 0.12, -0.12, 0.12].forEach((x, index) => {
        const y = index < 2 ? 0.07 : -0.07;
        const part = index === 0 ? new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.07, 20), new THREE.MeshStandardMaterial({ color: colors[index] })) : index === 1 ? new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.055, 6), new THREE.MeshStandardMaterial({ color: colors[index] })) : index === 2 ? new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.055, 0.055), new THREE.MeshStandardMaterial({ color: colors[index] })) : new THREE.Mesh(new THREE.TorusGeometry(0.025, 0.008, 10, 24), new THREE.MeshStandardMaterial({ color: colors[index] }));
        part.position.set(x, y, 0.045); if (index === 0 || index === 1) part.rotation.x = Math.PI / 2; root.add(part);
      });
      scene.add(root);
      const reticle = new THREE.Mesh(new THREE.RingGeometry(0.05, 0.06, 32), new THREE.MeshBasicMaterial({ color: 0x80dfff, side: THREE.DoubleSide })); reticle.rotation.x = -Math.PI / 2; reticle.visible = false; scene.add(reticle);
      rendererRef.current = renderer; sessionRef.current = session; setActive(true);
      const hitTestSource = await session.requestHitTestSource?.({ space: await session.requestReferenceSpace("viewer") });
      (session as XRSession & { __spatialforgeHit?: XRHitTestSource }).__spatialforgeHit = hitTestSource ?? undefined;
      session.addEventListener("select", () => { if (reticle.visible) { root.position.copy(reticle.position); root.quaternion.copy(reticle.quaternion); root.visible = true; reticle.visible = false; setPlaced(true); onStatus?.("Virtual workbench anchored"); } });
      session.addEventListener("end", () => { setActive(false); setPlaced(false); renderer.dispose(); renderer.domElement.remove(); sessionRef.current = null; rendererRef.current = null; onStatus?.("AR session ended"); });
      onStatus?.("Move your phone to find a surface");
    } catch { onStatus?.("Markerless AR unavailable · use camera overlay"); }
  };

  if (!supported) return <span className="xr-fallback">Surface AR unavailable on this browser</span>;
  return <span ref={hostRef} className="xr-control"><button type="button" onClick={() => active ? sessionRef.current?.end() : start()}>{active ? "Exit surface AR" : placed ? "AR workbench placed" : "Place in surface AR"}</button></span>;
}
