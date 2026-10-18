export type ScenarioId = "tray" | "valve" | "pneumatic";
export type PartId = "A1" | "A2" | "A3" | "A4" | "V1" | "V2" | "V3" | "V4" | "P1" | "P2" | "P3" | "P4" | "P5" | "P6" | "P7" | "P8";
export type TargetId = PartId;
export type PlacementMethod = "gesture" | "touch" | "assisted";
export type Point = { x: number; y: number };

export type PartDefinition = {
  id: PartId;
  name: string;
  short: string;
  cue: string;
  color: string;
  target: TargetId;
  requiredRotation: number;
  prerequisites: PartId[];
  primitive: "cylinder" | "hex" | "cube" | "torus" | "ring";
};

export type ScenarioDefinition = { id: ScenarioId; name: string; description: string; parts: readonly PartDefinition[] };

export const PARTS = [
  { id: "A1", name: "Cylinder Core", short: "Cylinder", cue: "Stand the core upright", color: "#80dfff", target: "A1", requiredRotation: 0, prerequisites: [], primitive: "cylinder" },
  { id: "A2", name: "Hexagonal Valve Block", short: "Hex block", cue: "Point the marked face toward you", color: "#ffbd70", target: "A2", requiredRotation: 0, prerequisites: [], primitive: "hex" },
  { id: "A3", name: "Cube Module", short: "Cube", cue: "Keep the green mark on top", color: "#c4f48e", target: "A3", requiredRotation: 0, prerequisites: [], primitive: "cube" },
  { id: "A4", name: "Toroid Seal Ring", short: "Seal ring", cue: "Lay the ring flat in its seat", color: "#c5a6ff", target: "A4", requiredRotation: 0, prerequisites: [], primitive: "torus" },
] as const satisfies readonly PartDefinition[];

export const VALVE_PARTS = [
  { id: "V1", name: "O-ring Seal", short: "O-ring", cue: "Seat the seal flat in the lower groove", color: "#c5a6ff", target: "V1", requiredRotation: 0, prerequisites: [], primitive: "ring" },
  { id: "V2", name: "Cylinder Spool", short: "Spool", cue: "Align the keyed notch toward the front", color: "#80dfff", target: "V2", requiredRotation: 90, prerequisites: ["V1"], primitive: "cylinder" },
  { id: "V3", name: "Hex Gland Nut", short: "Gland nut", cue: "Turn the marked face toward the operator", color: "#ffbd70", target: "V3", requiredRotation: 0, prerequisites: ["V2"], primitive: "hex" },
  { id: "V4", name: "Actuator Cap", short: "Cap", cue: "Keep the green mark on top", color: "#c4f48e", target: "V4", requiredRotation: 180, prerequisites: ["V3"], primitive: "cube" },
] as const satisfies readonly PartDefinition[];

export const PNEUMATIC_PARTS = [
  { id: "P1", name: "Valve Body", short: "Body", cue: "Seat the body as the base component", color: "#80dfff", target: "P1", requiredRotation: 0, prerequisites: [], primitive: "hex" },
  { id: "P2", name: "Body O-ring", short: "O-ring", cue: "Lay the seal flat in the body groove", color: "#c5a6ff", target: "P2", requiredRotation: 0, prerequisites: ["P1"], primitive: "ring" },
  { id: "P3", name: "Valve Spool", short: "Spool", cue: "Align the keyed notch toward the front", color: "#80dfff", target: "P3", requiredRotation: 90, prerequisites: ["P2"], primitive: "cylinder" },
  { id: "P4", name: "Return Spring", short: "Spring", cue: "Keep the spring axis vertical", color: "#d8e2e5", target: "P4", requiredRotation: 0, prerequisites: ["P3"], primitive: "torus" },
  { id: "P5", name: "Gland Nut", short: "Gland", cue: "Turn the marked face toward the operator", color: "#ffbd70", target: "P5", requiredRotation: 0, prerequisites: ["P4"], primitive: "hex" },
  { id: "P6", name: "Actuator Cap", short: "Cap", cue: "Keep the green mark on top", color: "#c4f48e", target: "P6", requiredRotation: 180, prerequisites: ["P5"], primitive: "cube" },
  { id: "P7", name: "Locking Clip", short: "Clip", cue: "Turn the clip tab toward the right", color: "#f2a5c2", target: "P7", requiredRotation: 90, prerequisites: ["P6"], primitive: "cube" },
  { id: "P8", name: "Adjustment Screw", short: "Screw", cue: "Align the driver slot with the front", color: "#f0c878", target: "P8", requiredRotation: 0, prerequisites: ["P6"], primitive: "cylinder" },
] as const satisfies readonly PartDefinition[];

export const SCENARIOS = {
  tray: { id: "tray", name: "Precision tray", description: "Four shapes, four matching slots. Complete them in any order.", parts: PARTS },
  valve: { id: "valve", name: "Small valve assembly", description: "Build the valve from seal to cap. Every part stays accessible, but prerequisites protect the assembly.", parts: VALVE_PARTS },
  pneumatic: { id: "pneumatic", name: "Pneumatic control valve", description: "Assemble an eight-part industrial control valve with a protected core sequence and a final cap branch.", parts: PNEUMATIC_PARTS },
} as const satisfies Record<ScenarioId, ScenarioDefinition>;

export const SCENARIO_IDS: ScenarioId[] = ["tray", "valve", "pneumatic"];
export const SLOT_IDS = PARTS.map((part) => part.id) as PartId[];
export function getScenario(id: ScenarioId): ScenarioDefinition { return SCENARIOS[id]; }
export function partFor(scenario: ScenarioId, id: PartId | null): PartDefinition | null { return getScenario(scenario).parts.find((part) => part.id === id) ?? null; }

export function sceneLayout(width: number, height: number, scenario: ScenarioId = "tray") {
  const aspect = Math.max(width, 1) / Math.max(height, 1);
  const viewHeight = 8;
  const viewWidth = viewHeight * aspect;
  const boardWidth = Math.min(viewWidth * 0.88, 6.2);
  const boardHeight = scenario === "pneumatic" ? 4.55 : 3.45;
  const slotX = boardWidth * 0.245;
  const slotY = 0.82;
  const ids = getScenario(scenario).parts.map((part) => part.id);
  const worldSlots: Record<PartId, Point> = {
    A1: { x: -slotX, y: slotY }, A2: { x: slotX, y: slotY }, A3: { x: -slotX, y: -slotY }, A4: { x: slotX, y: -slotY },
    V1: { x: -slotX, y: slotY }, V2: { x: slotX, y: slotY }, V3: { x: -slotX, y: -slotY }, V4: { x: slotX, y: -slotY },
    P1: { x: -0.25, y: 0.42 }, P2: { x: -1.05, y: 0.42 }, P3: { x: -0.18, y: 0.42 }, P4: { x: 0.68, y: 0.42 },
    P5: { x: 1.17, y: 0.42 }, P6: { x: 1.68, y: 0.42 }, P7: { x: 1.98, y: 0.42 }, P8: { x: -0.25, y: 1.34 },
  };
  const normalizedSlots = Object.fromEntries(ids.map((id) => [id, worldToScreen(worldSlots[id], viewWidth, viewHeight)])) as Record<PartId, Point>;
  const sourceY = -2.82;
  const sourceX = boardWidth * 0.23;
  const columns = Math.min(4, ids.length);
  const sources = ids.map((_, index) => ({ x: (index % columns - (columns - 1) / 2) * sourceX, y: sourceY - Math.floor(index / columns) * 0.52 }));
  const normalizedSources = Object.fromEntries(ids.map((id, index) => [id, worldToScreen(sources[index], viewWidth, viewHeight)])) as Record<PartId, Point>;
  return { viewWidth, viewHeight, boardWidth, boardHeight, worldSlots, normalizedSlots, sources, normalizedSources };
}

export function worldToScreen(point: Point, width: number, height: number): Point { return { x: point.x / width + 0.5, y: 0.5 - point.y / height }; }
export function screenToWorld(point: Point, width: number, height: number): Point { return { x: (point.x - 0.5) * width, y: (0.5 - point.y) * height }; }

export function slotAt(point: Point, slots: Record<PartId, Point>, width: number, height: number, ids: readonly PartId[] = SLOT_IDS, radiusScale = 1): PartId | null {
  const radiusX = (width / Math.max(height, 1) < 0.8 ? 0.19 : 0.13) * radiusScale;
  const radiusY = 0.115 * radiusScale;
  let closest: PartId | null = null;
  let distance = Infinity;
  for (const id of ids) {
    const center = slots[id];
    if (!center) continue;
    const d = ((point.x - center.x) / radiusX) ** 2 + ((point.y - center.y) / radiusY) ** 2;
    if (d < 1 && d < distance) { closest = id; distance = d; }
  }
  return closest;
}

export function sourceAt(point: Point, sources: Record<PartId, Point>, completed: ReadonlySet<PartId>, width: number, height: number, ids: readonly PartId[] = SLOT_IDS, radiusScale = 1): PartId | null {
  const radius = Math.min(66, Math.max(42, width * 0.13)) * radiusScale;
  let closest: PartId | null = null;
  let distance = radius;
  for (const id of ids) {
    if (completed.has(id)) continue;
    const source = sources[id];
    if (!source) continue;
    const pixels = Math.hypot((point.x - source.x) * width, (point.y - source.y) * height);
    if (pixels < distance) { closest = id; distance = pixels; }
  }
  return closest;
}

export function normalizeRotation(value: number): number { return ((value % 360) + 360) % 360; }
