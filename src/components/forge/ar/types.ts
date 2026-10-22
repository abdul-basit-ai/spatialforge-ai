import type { ForgeScenario } from "@/lib/forge/types";

// Contract props for both AR modes (re-exported from ../ARModes). operatorId is an additive optional field for telemetry.
export type ARModeProps = { scenario: ForgeScenario; onExit: () => void; operatorId?: string };

export type VerifyStatus = "pass" | "fail" | "unsure";
export type VerifyResponse = { status: VerifyStatus; confidence: number; message: string; observed: string; available?: boolean; model?: string; ms?: number; error?: string };
