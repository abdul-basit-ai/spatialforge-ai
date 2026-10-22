import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { ForgePart, Transform } from "./types";

// Builds Three.js objects for Forge parts. Shared by the 3D trainer, AR modes, and the studio editor.
// Primitive params are metres; meshes come from glTF assets served at /api/forge/assets/<id>.

const gltfCache = new Map<string, Promise<THREE.Group>>();

export function loadAsset(assetId: string): Promise<THREE.Group> {
  let cached = gltfCache.get(assetId);
  if (!cached) {
    cached = new GLTFLoader().loadAsync(`/api/forge/assets/${assetId}`).then((gltf) => gltf.scene);
    gltfCache.set(assetId, cached);
  }
  return cached;
}

export function primitiveGeometry(shape: string, p: Record<string, number>): THREE.BufferGeometry {
  const r = p.radius ?? 0.02, len = p.length ?? p.height ?? 0.05;
  switch (shape) {
    case "cylinder": case "shaft": case "leadscrew": case "cap": case "motor": return new THREE.CylinderGeometry(r, r, len, 32);
    case "tube": case "bearing": case "coupling": case "pulley": return new THREE.CylinderGeometry(r, r, len, 32, 1, true);
    case "hex": case "nut": return new THREE.CylinderGeometry(r, r, len, 6);
    case "torus": case "washer": return new THREE.TorusGeometry(r, p.tube ?? r * 0.25, 12, 32);
    case "bolt": case "screw": return new THREE.CylinderGeometry(p.radius ?? 0.003, p.radius ?? 0.003, len, 12);
    case "gear": return new THREE.CylinderGeometry(r, r, p.thickness ?? 0.01, Math.max(8, p.teeth ?? 20));
    case "spring": return new THREE.TorusKnotGeometry(r, r * 0.12, 64, 6, 1, Math.max(2, p.turns ?? 6));
    default: return new THREE.BoxGeometry(p.width ?? 0.05, p.height ?? 0.05, p.depth ?? 0.05);
  }
}

export async function buildPartObject(part: ForgePart): Promise<THREE.Object3D> {
  const holder = new THREE.Group();
  holder.name = part.id;
  holder.userData.partId = part.id;
  if (part.geometry.kind === "mesh") {
    const { assetId, node } = part.geometry;
    const scene = await loadAsset(assetId);
    const source = scene.getObjectByName(node) ?? scene;
    holder.add(source.clone(true));
  } else {
    const material = new THREE.MeshStandardMaterial({ color: part.color ?? "#9fb3c8", metalness: 0.4, roughness: 0.45 });
    holder.add(new THREE.Mesh(primitiveGeometry(part.geometry.shape, part.geometry.params), material));
  }
  return holder;
}

export function applyTransform(object: THREE.Object3D, transform: Transform) {
  object.position.set(...transform.position);
  object.quaternion.set(...transform.quaternion);
}

export function readTransform(object: THREE.Object3D): Transform {
  return { position: [object.position.x, object.position.y, object.position.z], quaternion: [object.quaternion.x, object.quaternion.y, object.quaternion.z, object.quaternion.w] };
}
