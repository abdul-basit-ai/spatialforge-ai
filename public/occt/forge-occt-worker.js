// Forge CAD worker: parses STEP/IGES/BREP with occt-import-js off the main thread.
// Message in: { id, format: "step"|"iges"|"brep", buffer: ArrayBuffer, params }.
// Message out: { id, result } with typed arrays (transferred) or { id, error }.
importScripts("/occt/occt-import-js.js");

let ready = null;
const occt = () => (ready ??= occtimportjs({ locateFile: (file) => "/occt/" + file }));
occt(); // start compiling the wasm as soon as the worker exists

onmessage = async (event) => {
  const { id, format, buffer, params } = event.data;
  try {
    const lib = await occt();
    const content = new Uint8Array(buffer);
    const result = format === "iges" ? lib.ReadIgesFile(content, params) : format === "brep" ? lib.ReadBrepFile(content, params) : lib.ReadStepFile(content, params);
    if (!result || !result.success) { postMessage({ id, error: "OpenCascade could not read this file" }); return; }
    const transfer = [];
    const meshes = result.meshes.map((mesh) => {
      const position = new Float32Array(mesh.attributes.position.array);
      const normal = mesh.attributes.normal ? new Float32Array(mesh.attributes.normal.array) : null;
      const index = mesh.index ? new Uint32Array(mesh.index.array) : null;
      transfer.push(position.buffer); if (normal) transfer.push(normal.buffer); if (index) transfer.push(index.buffer);
      return { name: mesh.name, color: mesh.color, brep_faces: mesh.brep_faces, attributes: { position: { array: position }, normal: normal ? { array: normal } : undefined }, index: index ? { array: index } : undefined };
    });
    postMessage({ id, result: { success: true, root: result.root, meshes } }, transfer);
  } catch (error) {
    postMessage({ id, error: String((error && error.message) || error) });
  }
};
