import { getScenario, normalizeRotation, partFor, type PartId, type PlacementMethod, type ScenarioId } from "@/lib/assembly";

export type Vec3 = { x: number; y: number; z: number };
export type Quaternion = { x: number; y: number; z: number; w: number };

export type Pose = { position: Vec3; rotation: Quaternion; scale?: Vec3 };

export type InteractionSource = "mouse" | "touch" | "gesture" | "xr-controller" | "xr-hand";
export type InteractionIntent =
  | { type: "hover"; source: InteractionSource; point: { x: number; y: number }; confidence: number; at: number }
  | { type: "grab-start"; source: InteractionSource; partId: PartId; point: { x: number; y: number }; confidence: number; at: number }
  | { type: "move"; source: InteractionSource; partId: PartId; point: { x: number; y: number }; confidence: number; at: number }
  | { type: "rotate"; source: InteractionSource; partId: PartId; degrees: number; at: number }
  | { type: "release"; source: InteractionSource; partId: PartId; point: { x: number; y: number } | null; at: number }
  | { type: "cancel"; source: InteractionSource; partId: PartId; reason: string; at: number };

export type ValidationResult = {
  accepted: boolean;
  partId: PartId;
  targetId: PartId | null;
  position: "pass" | "fail";
  orientation: "pass" | "fail";
  collision: "pass" | "fail";
  prerequisite: "pass" | "fail";
  reason: "accepted" | "wrong-target" | "orientation" | "prerequisite" | "collision" | "no-target";
};

export type AssemblyRuntimeState = {
  scenario: ScenarioId;
  installed: ReadonlySet<PartId>;
  rotations: Readonly<Record<string, number>>;
};

export type AssemblyDefinition = {
  id: ScenarioId;
  units: "meters";
  snapRadius: number;
  positionTolerance: number;
  orientationTolerance: number;
  partColliders: Readonly<Record<string, { radius: number; height: number }>>;
};

export const DEFAULT_ASSEMBLY_DEFINITION: AssemblyDefinition = {
  id: "valve",
  units: "meters",
  snapRadius: 0.05,
  positionTolerance: 0.025,
  orientationTolerance: 15,
  partColliders: { V1: { radius: 0.04, height: 0.012 }, V2: { radius: 0.035, height: 0.09 }, V3: { radius: 0.055, height: 0.03 }, V4: { radius: 0.06, height: 0.05 } },
};

export function validatePlacement(state: AssemblyRuntimeState, partId: PartId, targetId: PartId | null, rotation: number, collision = false): ValidationResult {
  const part = partFor(state.scenario, partId);
  if (!part) return { accepted: false, partId, targetId, position: "fail", orientation: "fail", collision: "pass", prerequisite: "fail", reason: "no-target" };
  const targetPass = targetId === part.target;
  const missing = part.prerequisites.some((id) => !state.installed.has(id));
  const orientationPass = Math.abs(normalizeRotation(rotation) - normalizeRotation(part.requiredRotation)) <= DEFAULT_ASSEMBLY_DEFINITION.orientationTolerance || (Math.abs(normalizeRotation(rotation) - normalizeRotation(part.requiredRotation)) >= 345);
  const accepted = targetPass && !missing && orientationPass && !collision;
  return {
    accepted,
    partId,
    targetId,
    position: targetPass ? "pass" : "fail",
    orientation: orientationPass ? "pass" : "fail",
    collision: collision ? "fail" : "pass",
    prerequisite: missing ? "fail" : "pass",
    reason: accepted ? "accepted" : !targetPass ? (targetId ? "wrong-target" : "no-target") : missing ? "prerequisite" : !orientationPass ? "orientation" : "collision",
  };
}

export type CapabilityReport = {
  browser: string;
  secureContext: boolean;
  webgl: boolean;
  camera: boolean;
  mediaPipe: boolean;
  immersiveAr: boolean;
  hitTest: boolean;
  anchors: boolean;
  immersiveVr: boolean;
};

export async function detectCapabilities(): Promise<CapabilityReport> {
  if (typeof window === "undefined") return { browser: "server", secureContext: false, webgl: false, camera: false, mediaPipe: false, immersiveAr: false, hitTest: false, anchors: false, immersiveVr: false };
  const ua = navigator.userAgent;
  let immersiveAr = false;
  let immersiveVr = false;
  const xr = (navigator as Navigator & { xr?: { isSessionSupported?: (mode: string) => Promise<boolean> } }).xr;
  if (xr?.isSessionSupported) {
    [immersiveAr, immersiveVr] = await Promise.all([xr.isSessionSupported("immersive-ar").catch(() => false), xr.isSessionSupported("immersive-vr").catch(() => false)]);
  }
  const canvas = document.createElement("canvas");
  const webgl = Boolean(canvas.getContext("webgl2") || canvas.getContext("webgl"));
  return { browser: ua, secureContext: window.isSecureContext, webgl, camera: Boolean(navigator.mediaDevices?.getUserMedia), mediaPipe: true, immersiveAr, hitTest: immersiveAr, anchors: immersiveAr, immersiveVr };
}

export const DEFAULT_DAG_VERSION = "1.0";

export type SpatialEvent = { schemaVersion: 1; sessionId: string; sequence: number; type: string; at: string; mode: "workbench" | "camera" | "xr-ar" | "xr-vr"; source?: InteractionSource; scenario: ScenarioId; operator?: string; dagVersion: string; partId?: PartId; payload: Record<string, unknown> };

// Always UUID-shaped (the server only stores UUID session ids); randomUUID is missing outside secure contexts.
export function makeSessionId() {
  const api = typeof crypto !== "undefined" ? crypto as Partial<Crypto> : undefined;
  if (api?.randomUUID) return api.randomUUID();
  const bytes = api?.getRandomValues ? Array.from(api.getRandomValues(new Uint8Array(16))) : Array.from({ length: 16 }, () => Math.floor(Math.random() * 256));
  bytes[6] = (bytes[6] & 0x0f) | 0x40; bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.map((value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function makeSpatialEvent(input: Omit<SpatialEvent, "schemaVersion" | "dagVersion"> & { dagVersion?: string }): SpatialEvent { return { schemaVersion: 1, ...input, dagVersion: input.dagVersion || DEFAULT_DAG_VERSION }; }

export type PlacementRecord = { scenario: ScenarioId; partId: PartId; targetId: PartId; rotation: number; method: PlacementMethod; at: string };
