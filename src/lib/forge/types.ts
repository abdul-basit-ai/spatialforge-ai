// SpatialForge "Forge" scenario format: the shared contract between import, compiler, editor, engine, trainer, AR, voice, and memory.
// Units are metres and degrees. The assembly frame is Y-up; the base part sits at the origin.

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number]; // x, y, z, w
export type Transform = { position: Vec3; quaternion: Quat };

export type PrimitiveShape =
  | "box" | "plate" | "bracket" | "cylinder" | "shaft" | "tube" | "hex" | "torus" | "washer" | "nut" | "bolt" | "screw"
  | "spring" | "gear" | "pulley" | "belt" | "bearing" | "coupling" | "rail" | "carriage" | "leadscrew"
  | "motor" | "sensor" | "pcb" | "connector" | "cable" | "housing" | "cap";

// Geometry is either a mesh from an imported asset (glTF binary stored in forge_assets) or a parametric primitive.
// Primitive params are metres: e.g. { radius, length } for cylinder/shaft, { width, height, depth } for box, { radius, teeth, thickness } for gear.
export type ForgeGeometry =
  | { kind: "mesh"; assetId: string; node: string }
  | { kind: "primitive"; shape: PrimitiveShape; params: Record<string, number> };

export type PartCategory = "structural" | "fastener" | "seal" | "bearing" | "drive" | "motor" | "sensor" | "electronics" | "connector" | "cable" | "tool" | "other";

// How a part seats. axis = unit insertion direction in the assembly frame (from approach toward seat).
// symmetryDeg = rotational symmetry about the axis: 360 means keyed (one orientation), 90 means a square, 0 means any angle.
export type Mate = {
  type: "fixed" | "axial" | "planar";
  axis?: Vec3;
  positionTolerance: number;
  angleToleranceDeg: number;
  symmetryDeg?: number;
};

export type ForgePart = {
  id: string;
  name: string;
  category: PartCategory;
  geometry: ForgeGeometry;
  color?: string;
  assembled: Transform; // final pose in the assembly frame
  mate: Mate;
  description?: string;
};

export type StepKind = "place" | "fasten" | "connect" | "route" | "adjust" | "inspect" | "tool";

export type ForgeStep = {
  id: string;
  kind: StepKind;
  title: string;
  instruction: string; // shown on screen
  voiceLine: string; // spoken by ElevenLabs; short, imperative
  partIds: string[]; // parts this step installs or acts on ("place"/"fasten"/"connect"/"route" need at least one)
  requires: string[]; // step ids that must be complete first
  tool?: string; // e.g. "3 mm hex key", "torque wrench"
  torqueNm?: number;
  pattern?: string; // e.g. "cross pattern, two passes"
  target?: { label: string; value: number; unit: string; tolerance?: number }; // for "adjust"
  checklist?: string[]; // for "inspect"
  warnings?: string[];
  hints?: string[];
  commonMistakes?: string[];
  audio?: { url: string; voiceId?: string };
};

export type ForgeSource = {
  kind: "upload" | "web" | "generated" | "builtin";
  files?: Array<{ name: string; mime: string; assetId?: string }>;
  urls?: Array<{ title: string; url: string; license?: string }>;
  prompt?: string;
  approximation: boolean; // true when geometry or procedure is AI-estimated
  notes?: string;
};

export type ForgeScenario = {
  id: string; // slug, e.g. "linear-actuator"
  version: number; // increments on each publish
  status: "draft" | "published";
  title: string;
  summary: string;
  domain: "mechanical" | "mechatronic";
  source: ForgeSource;
  baseParts: string[]; // parts already in place at the start (fixtures/base)
  parts: ForgePart[];
  steps: ForgeStep[];
  issues?: string[]; // validator output; a scenario with issues cannot be published
  createdAt: string;
  updatedAt: string;
};

export type TrainingMode = "3d" | "ar-train" | "ar-assist";

export type MistakeReason = "wrong-part" | "out-of-order" | "position" | "orientation" | "blocked" | "wrong-tool" | "out-of-range" | "not-confirmed";

export type ForgeEventType =
  | "forge_session_started" | "forge_step_started" | "forge_step_completed" | "forge_mistake"
  | "forge_hint_shown" | "forge_vision_check" | "forge_session_completed";

// Sent to /api/events (stored in ClickHouse spatial_events with scenario_id = "forge:<id>", dag_version = "<version>").
export type ForgeEvent = {
  type: ForgeEventType;
  scenarioId: string;
  scenarioVersion: number;
  sessionId: string; // uuid
  sequence: number;
  operatorId: string;
  mode: TrainingMode;
  stepId?: string;
  partId?: string;
  reason?: MistakeReason;
  message?: string;
  ms?: number; // time on step
  at: string; // ISO time
};
