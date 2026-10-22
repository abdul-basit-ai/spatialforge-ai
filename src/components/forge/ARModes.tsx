"use client";

// AR modes (contract). Both read and drive the shared run via useForgeRun(); correctness always comes from the engine.
// ARTrainer: virtual parts placed on a real surface (WebXR immersive-ar with hit-test + dom-overlay; camera pass-through
//            screen-locked fallback on iOS/desktop).
// ARAssist:  ghost of the current step over real hardware + camera snapshot verification via /api/forge/verify-step.
// Implementation lives in ./ar/ (stage.ts = shared three.js/WebXR stage, shell.tsx = layout, useArRun.ts = run wiring).
export type { ARModeProps } from "./ar/types";
export { ARTrainer } from "./ar/ARTrainer";
export { ARAssist } from "./ar/ARAssist";
