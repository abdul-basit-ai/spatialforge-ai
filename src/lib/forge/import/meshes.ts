import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import type { RawFile, RawPart } from "./assemble";

// STL / OBJ / GLB through three.js loaders. Every mesh becomes a part, baked into the file's frame.
// STL and OBJ carry no units (auto-detected later); GLB is metres by spec. CAD-exported STL is usually Z-up.

const colorOf = (material: THREE.Material | THREE.Material[]): [number, number, number] | undefined => {
  const first = Array.isArray(material) ? material[0] : material;
  const color = (first as THREE.MeshStandardMaterial | undefined)?.color;
  return color && !(color.r === 1 && color.g === 1 && color.b === 1) ? [color.r, color.g, color.b] : undefined;
};

function partsFromObject(root: THREE.Object3D, fallbackName: string): RawPart[] {
  // A Forge GLB stores part nodes at the identity pose with the assembled position in extras; restore it.
  root.traverse((object) => { const p = object.userData?.position; if (object.userData?.forgePart && Array.isArray(p) && p.length === 3) object.position.set(p[0], p[1], p[2]); });
  root.updateMatrixWorld(true);
  const parts: RawPart[] = [];
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const geometry = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
    for (const key of Object.keys(geometry.attributes)) if (!["position", "normal"].includes(key)) geometry.deleteAttribute(key); // textures are dropped; CAD parts are flat-shaded hardware
    const path: string[] = [];
    for (let parent = mesh.parent; parent && parent !== root; parent = parent.parent) if (parent.name) path.unshift(parent.name);
    // GLTFLoader splits multi-material meshes into "<name>_1", "<name>_2" children of a group named after the node.
    const forge = mesh.parent?.userData?.forgePart ? String(mesh.parent.userData.name ?? mesh.parent.name).replace(/\s\d+$/, "") : "";
    const name = forge || (mesh.name && !/^mesh_\d+$/.test(mesh.name) ? mesh.name : mesh.parent && mesh.parent !== root ? mesh.parent.name : fallbackName);
    parts.push({ name, path, color: colorOf(mesh.material), geometry });
  });
  return parts;
}

export async function readMeshFile(name: string, format: "stl" | "obj" | "glb", buffer: ArrayBuffer): Promise<RawFile> {
  const base = name.replace(/\.[^.]+$/, "");
  if (format === "stl") {
    const geometry = new STLLoader().parse(buffer);
    const colors = geometry.getAttribute("color");
    if (colors) geometry.deleteAttribute("color");
    return { file: name, format, parts: [{ name: base, path: [], geometry }], units: "auto", up: "z" };
  }
  if (format === "obj") {
    const group = new OBJLoader().parse(new TextDecoder().decode(buffer));
    return { file: name, format, parts: partsFromObject(group, base), units: "auto", up: "y" };
  }
  const gltf = await new GLTFLoader().parseAsync(buffer, "");
  return { file: name, format, parts: partsFromObject(gltf.scene, base), units: "auto", up: "y" };
}
