// Minimal glTF 2.0 binary writer (Node-side; GLTFExporter needs browser FileReader).
// One node per part, each with an identity transform and vertices already in the assembly frame relative to the node origin.

export type GlbMesh = { name: string; positions: Float32Array; normals?: Float32Array; indices?: Uint32Array; color?: [number, number, number] };

export function writeGlb(meshes: GlbMesh[]): Buffer {
  const chunks: Buffer[] = [];
  let offset = 0;
  const bufferViews: Array<Record<string, unknown>> = [], accessors: Array<Record<string, unknown>> = [];
  const push = (data: ArrayBufferView, target: number) => {
    const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    const pad = (4 - (bytes.length % 4)) % 4;
    chunks.push(bytes, Buffer.alloc(pad));
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length, target });
    offset += bytes.length + pad;
    return bufferViews.length - 1;
  };
  const materials: Array<Record<string, unknown>> = [], meshesJson: Array<Record<string, unknown>> = [], nodes: Array<Record<string, unknown>> = [];
  for (const mesh of meshes) {
    const count = mesh.positions.length / 3;
    if (!count) continue;
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < mesh.positions.length; i += 3) for (let k = 0; k < 3; k++) { const v = mesh.positions[i + k]; if (v < min[k]) min[k] = v; if (v > max[k]) max[k] = v; }
    const attributes: Record<string, number> = {};
    accessors.push({ bufferView: push(mesh.positions, 34962), componentType: 5126, count, type: "VEC3", min, max });
    attributes.POSITION = accessors.length - 1;
    if (mesh.normals && mesh.normals.length === mesh.positions.length) { accessors.push({ bufferView: push(mesh.normals, 34962), componentType: 5126, count, type: "VEC3" }); attributes.NORMAL = accessors.length - 1; }
    const primitive: Record<string, unknown> = { attributes, material: materials.length };
    if (mesh.indices?.length) { accessors.push({ bufferView: push(mesh.indices, 34963), componentType: 5125, count: mesh.indices.length, type: "SCALAR" }); primitive.indices = accessors.length - 1; }
    const [r, g, b] = mesh.color ?? [0.62, 0.7, 0.78];
    materials.push({ name: `${mesh.name}-mat`, pbrMetallicRoughness: { baseColorFactor: [r, g, b, 1], metallicFactor: 0.4, roughnessFactor: 0.5 } });
    meshesJson.push({ name: mesh.name, primitives: [primitive] });
    nodes.push({ name: mesh.name, mesh: meshesJson.length - 1 });
  }
  const json = { asset: { version: "2.0", generator: "SpatialForge compiler" }, scene: 0, scenes: [{ nodes: nodes.map((_, i) => i) }], nodes, meshes: meshesJson, materials, accessors, bufferViews, buffers: [{ byteLength: offset }] };
  let jsonBytes = Buffer.from(JSON.stringify(json), "utf8");
  jsonBytes = Buffer.concat([jsonBytes, Buffer.alloc((4 - (jsonBytes.length % 4)) % 4, 0x20)]);
  const bin = Buffer.concat(chunks);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + jsonBytes.length + 8 + bin.length, 8);
  const chunkHeader = (length: number, type: number) => { const h = Buffer.alloc(8); h.writeUInt32LE(length, 0); h.writeUInt32LE(type, 4); return h; };
  return Buffer.concat([header, chunkHeader(jsonBytes.length, 0x4e4f534a), jsonBytes, chunkHeader(bin.length, 0x004e4942), bin]);
}
