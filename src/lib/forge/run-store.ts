"use client";

import { create } from "zustand";
import { attemptPlace, attemptStep, createRun, isComplete, type RunState, type StepEvidence, type Verdict } from "./engine";
import type { ForgeScenario, Transform, TrainingMode } from "./types";

// Client-side run state shared by every training mode (3D, AR training, AR assist).
// UI components call place()/complete(); they never decide correctness themselves.
export type ForgeRunStore = {
  scenario: ForgeScenario | null;
  run: RunState | null;
  mode: TrainingMode;
  sessionId: string | null;
  lastVerdict: Verdict | null;
  start: (scenario: ForgeScenario, mode?: TrainingMode) => void;
  setMode: (mode: TrainingMode) => void;
  place: (partId: string, pose: Transform) => Verdict | null;
  complete: (stepId: string, evidence: StepEvidence) => Verdict | null;
  reset: () => void;
  done: () => boolean;
};

const uuid = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : "00000000-0000-4000-8000-" + Math.random().toString(16).slice(2, 14).padEnd(12, "0"));

export const useForgeRun = create<ForgeRunStore>((set, get) => ({
  scenario: null, run: null, mode: "3d", sessionId: null, lastVerdict: null,
  start: (scenario, mode = get().mode) => set({ scenario, run: createRun(scenario), mode, sessionId: uuid(), lastVerdict: null }),
  setMode: (mode) => set({ mode }),
  place: (partId, pose) => {
    const { scenario, run } = get(); if (!scenario || !run) return null;
    const { verdict, run: next } = attemptPlace(scenario, run, partId, pose);
    set({ run: next, lastVerdict: verdict }); return verdict;
  },
  complete: (stepId, evidence) => {
    const { scenario, run } = get(); if (!scenario || !run) return null;
    const { verdict, run: next } = attemptStep(scenario, run, stepId, evidence);
    set({ run: next, lastVerdict: verdict }); return verdict;
  },
  reset: () => { const { scenario } = get(); if (scenario) set({ run: createRun(scenario), sessionId: uuid(), lastVerdict: null }); },
  done: () => { const { scenario, run } = get(); return Boolean(scenario && run && isComplete(scenario, run)); },
}));
