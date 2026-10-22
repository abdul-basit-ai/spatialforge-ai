// Upload policy shared by the Studio page (client) and /api/forge/assets (server). Pure, no Node or DOM APIs.

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 60 * 1024 * 1024;

export type AssetKind = "mesh" | "pdf" | "image" | "cad";
export type FileRole = "cad" | "mesh" | "pdf" | "image";

// Extensions the server stores. CAD sources are parsed in the browser and uploaded as GLB; raw CAD is accepted for archiving.
export const ASSET_TYPES: Record<string, { mime: string; kind: AssetKind }> = {
  glb: { mime: "model/gltf-binary", kind: "mesh" },
  pdf: { mime: "application/pdf", kind: "pdf" },
  png: { mime: "image/png", kind: "image" },
  jpg: { mime: "image/jpeg", kind: "image" },
  jpeg: { mime: "image/jpeg", kind: "image" },
  webp: { mime: "image/webp", kind: "image" },
  step: { mime: "model/step", kind: "cad" },
  stp: { mime: "model/step", kind: "cad" },
  iges: { mime: "model/iges", kind: "cad" },
  igs: { mime: "model/iges", kind: "cad" },
  brep: { mime: "application/octet-stream", kind: "cad" },
  stl: { mime: "model/stl", kind: "cad" },
  obj: { mime: "model/obj", kind: "cad" },
};

// Browser-reported MIME types accepted for each stored MIME (browsers often send "" or octet-stream for CAD).
const LOOSE = ["", "application/octet-stream", "binary/octet-stream"];
const ALIASES: Record<string, string[]> = {
  "model/gltf-binary": ["model/gltf-binary", ...LOOSE],
  "application/pdf": ["application/pdf", "application/x-pdf", ...LOOSE],
  "image/png": ["image/png"],
  "image/jpeg": ["image/jpeg", "image/jpg", "image/pjpeg"],
  "image/webp": ["image/webp"],
  "model/step": ["model/step", "application/step", "application/stp", "model/x-step", "text/plain", ...LOOSE],
  "model/iges": ["model/iges", "application/iges", "model/x-iges", "text/plain", ...LOOSE],
  "model/stl": ["model/stl", "application/sla", "application/vnd.ms-pki.stl", "model/x.stl-binary", "model/x.stl-ascii", "text/plain", ...LOOSE],
  "model/obj": ["model/obj", "text/plain", "application/x-tgif", ...LOOSE],
  "application/octet-stream": [...LOOSE, "text/plain"],
};

export const extensionOf = (name: string) => (name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "");

// Native CAD formats people try first, with the export advice shown to them.
const NATIVE_CAD: Record<string, string> = {
  sldprt: "SolidWorks .sldprt/.sldasm: export as STEP (File > Save As > STEP AP214) and upload the .step file.",
  sldasm: "SolidWorks .sldprt/.sldasm: export as STEP (File > Save As > STEP AP214) and upload the .step file.",
  slddrw: "SolidWorks drawings (.slddrw) are not 3D models: export the assembly as STEP, or upload the drawing as PDF.",
  ipt: "Inventor .ipt/.iam: export as STEP and upload the .step file.",
  iam: "Inventor .ipt/.iam: export as STEP and upload the .step file.",
  f3d: "Fusion 360 .f3d: export as STEP (File > Export > STEP) and upload the .step file.",
  catpart: "CATIA files: export as STEP and upload the .step file.",
  catproduct: "CATIA files: export as STEP and upload the .step file.",
  prt: "Creo/NX .prt: export as STEP and upload the .step file.",
  asm: "Creo .asm: export as STEP and upload the .step file.",
  x_t: "Parasolid .x_t: export as STEP and upload the .step file.",
  x_b: "Parasolid .x_b: export as STEP and upload the .step file.",
  fcstd: "FreeCAD .FCStd: export as STEP (File > Export > STEP) and upload the .step file.",
  "3dm": "Rhino .3dm: export as STEP and upload the .step file.",
  dwg: "DWG/DXF drawings are 2D: export the 3D model as STEP, or upload a PDF of the drawing.",
  dxf: "DWG/DXF drawings are 2D: export the 3D model as STEP, or upload a PDF of the drawing.",
  gltf: "Text .gltf files reference external buffers: export as binary .glb instead.",
  fbx: "FBX is not supported: export as GLB or STEP.",
  zip: "Archives are not supported: unzip and drop the STEP, PDF or image files directly.",
};

// Classifies a file picked in the Studio. Returns a role or a friendly reason it cannot be used.
export function classifyFile(name: string, size: number): { role: FileRole; format: string } | { error: string } {
  const ext = extensionOf(name);
  if (NATIVE_CAD[ext]) return { error: `${name}: ${NATIVE_CAD[ext]}` };
  if (size > MAX_FILE_BYTES) return { error: `${name} is ${(size / 1048576).toFixed(1)} MB; the limit is 25 MB per file. Export with coarser tessellation or split the assembly.` };
  if (size === 0) return { error: `${name} is empty.` };
  if (["step", "stp"].includes(ext)) return { role: "cad", format: "step" };
  if (["iges", "igs"].includes(ext)) return { role: "cad", format: "iges" };
  if (ext === "brep") return { role: "cad", format: "brep" };
  if (["stl", "obj", "glb"].includes(ext)) return { role: "mesh", format: ext };
  if (ext === "pdf") return { role: "pdf", format: "pdf" };
  if (["png", "jpg", "jpeg", "webp"].includes(ext)) return { role: "image", format: ext };
  return { error: `${name}: unsupported file type. Use STEP, IGES, BREP, STL, OBJ, GLB, PDF, PNG or JPG.` };
}

// Server-side check of one upload: extension allow-list, declared MIME, and magic bytes. Returns the stored MIME or an error.
export function checkUpload(name: string, declaredMime: string, head: Uint8Array): { mime: string; kind: AssetKind } | { error: string } {
  const ext = extensionOf(name);
  const type = ASSET_TYPES[ext];
  if (!type) return { error: NATIVE_CAD[ext] ? `${name}: ${NATIVE_CAD[ext]}` : `${name}: file type .${ext || "?"} is not allowed` };
  const declared = (declaredMime || "").toLowerCase().split(";")[0].trim();
  if (!(ALIASES[type.mime] ?? LOOSE).includes(declared)) return { error: `${name}: MIME type ${declared} does not match .${ext}` };
  const ascii = (from: number, to: number) => String.fromCharCode(...head.slice(from, to));
  const magic: Record<string, boolean> = {
    "model/gltf-binary": ascii(0, 4) === "glTF",
    "application/pdf": ascii(0, 1024).includes("%PDF-"),
    "image/png": head[0] === 0x89 && ascii(1, 4) === "PNG",
    "image/jpeg": head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff,
    "image/webp": ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP",
    "model/step": /ISO-10303-21/.test(ascii(0, 512)),
  };
  if (type.mime in magic && !magic[type.mime]) return { error: `${name}: contents do not look like a .${ext} file` };
  if (type.kind === "cad" && /<(html|script|svg)/i.test(ascii(0, 512))) return { error: `${name}: contents do not look like CAD data` };
  return type;
}
