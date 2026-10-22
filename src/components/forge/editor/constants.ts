import type { ForgeStep, PartCategory, PrimitiveShape, StepKind } from "@/lib/forge/types";

export const SHAPES: readonly PrimitiveShape[] = ["box", "plate", "bracket", "cylinder", "shaft", "tube", "hex", "torus", "washer", "nut", "bolt", "screw", "spring", "gear", "pulley", "belt", "bearing", "coupling", "rail", "carriage", "leadscrew", "motor", "sensor", "pcb", "connector", "cable", "housing", "cap"];
export const CATEGORIES: readonly PartCategory[] = ["structural", "fastener", "seal", "bearing", "drive", "motor", "sensor", "electronics", "connector", "cable", "tool", "other"];
export const STEP_KINDS: readonly StepKind[] = ["place", "fasten", "connect", "route", "adjust", "inspect", "tool"];
export const INSTALLING_KINDS: readonly StepKind[] = ["place", "connect", "route"];

export const KIND_META: Record<StepKind, { label: string; color: string; hint: string }> = {
  place: { label: "Place", color: "#22d3ee", hint: "Seat one or more parts on their mates" },
  fasten: { label: "Fasten", color: "#f5a524", hint: "Drive fasteners with a tool, torque and pattern" },
  connect: { label: "Connect", color: "#a78bfa", hint: "Mate a connector or plug a cable end" },
  route: { label: "Route", color: "#34d399", hint: "Lay a cable or hose along its path" },
  adjust: { label: "Adjust", color: "#fb7185", hint: "Set a measured value within tolerance" },
  inspect: { label: "Inspect", color: "#60a5fa", hint: "Check a list of conditions" },
  tool: { label: "Tool", color: "#facc15", hint: "Pick up or set up a tool" },
};

export const CATEGORY_COLORS: Record<PartCategory, string> = {
  structural: "#8a9bb0", fastener: "#c9ced6", seal: "#1f2937", bearing: "#b8c4d0", drive: "#d4a24c", motor: "#3b4250",
  sensor: "#2f9e8f", electronics: "#2f7d4f", connector: "#e5e7eb", cable: "#111827", tool: "#f5a524", other: "#9fb3c8",
};

// Primitive params shown in the editor per shape (metres in storage, millimetres in the UI).
export const SHAPE_PARAMS: Record<string, string[]> = {
  cylinder: ["radius", "length"], shaft: ["radius", "length"], leadscrew: ["radius", "length"], cap: ["radius", "length"], motor: ["radius", "length"],
  tube: ["radius", "length"], bearing: ["radius", "length"], coupling: ["radius", "length"], pulley: ["radius", "length"],
  hex: ["radius", "length"], nut: ["radius", "length"], torus: ["radius", "tube"], washer: ["radius", "tube"],
  bolt: ["radius", "length"], screw: ["radius", "length"], gear: ["radius", "thickness", "teeth"], spring: ["radius", "turns"],
};
export const UNITLESS_PARAMS = new Set(["teeth", "turns"]);
export const paramsFor = (shape: string) => SHAPE_PARAMS[shape] ?? ["width", "height", "depth"];

export const SYMMETRY_PRESETS: Array<{ value: number; label: string }> = [
  { value: 360, label: "Keyed (one way)" }, { value: 180, label: "180° (two ways)" }, { value: 120, label: "120° (three ways)" },
  { value: 90, label: "90° (square)" }, { value: 60, label: "60° (hex)" }, { value: 0, label: "Any angle (round)" },
];

export const AXIS_PRESETS: Array<{ label: string; axis: [number, number, number] }> = [
  { label: "↓ −Y", axis: [0, -1, 0] }, { label: "↑ +Y", axis: [0, 1, 0] }, { label: "→ +X", axis: [1, 0, 0] },
  { label: "← −X", axis: [-1, 0, 0] }, { label: "⊙ +Z", axis: [0, 0, 1] }, { label: "⊗ −Z", axis: [0, 0, -1] },
];

export const LIST_FIELDS: Array<{ key: "checklist" | "warnings" | "hints" | "commonMistakes"; label: string; placeholder: string }> = [
  { key: "checklist", label: "Checklist", placeholder: "e.g. Shaft spins freely by hand" },
  { key: "warnings", label: "Warnings", placeholder: "e.g. Do not overtighten the set screw" },
  { key: "hints", label: "Hints", placeholder: "e.g. Align the flat on the shaft with the set screw" },
  { key: "commonMistakes", label: "Common mistakes", placeholder: "e.g. Coupling installed upside down" },
];

export const blankStep = (id: string, kind: StepKind = "place"): ForgeStep => ({ id, kind, title: "New step", instruction: "", voiceLine: "", partIds: [], requires: [] });
