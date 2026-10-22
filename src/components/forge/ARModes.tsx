"use client";

import type { ForgeScenario } from "@/lib/forge/types";

// AR modes (contract stub; the AR agent implements these). Both read and drive the shared run via useForgeRun().
// ARTrainer: virtual parts placed on a real surface (WebXR immersive-ar with hit-test; camera pass-through fallback on iOS).
// ARAssist: ghost of the next step over real hardware + camera snapshot verification via /api/forge/verify-step.
export type ARModeProps = { scenario: ForgeScenario; onExit: () => void };

export function ARTrainer({ onExit }: ARModeProps) {
  return <div className="forge-ar-stub"><p>AR training is not available yet.</p><button type="button" onClick={onExit}>Back to 3D</button></div>;
}

export function ARAssist({ onExit }: ARModeProps) {
  return <div className="forge-ar-stub"><p>AR assist is not available yet.</p><button type="button" onClick={onExit}>Back to 3D</button></div>;
}
