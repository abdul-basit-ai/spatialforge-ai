"use client";

import { create } from "zustand";
import { attemptPlace, attemptStep, createRun, isComplete, stepById, type RunState, type StepEvidence, type Verdict } from "./engine";
import type { ForgeScenario, Transform, TrainingMode } from "./types";

// Client-side run state shared by every training mode (3D, AR training, AR assist).
// UI components call place()/complete(); they never decide correctness themselves (every verdict comes from engine.ts).
export type ForgeRunStore = {
  scenario: ForgeScenario | null;
  run: RunState | null;
  mode: TrainingMode;
  sessionId: string | null;
  lastVerdict: Verdict | null;
  verdictSeq: number; // increments on every verdict (so identical consecutive verdicts still re-trigger UI)
  operatorId: string | null;
  operatorName: string | null;
  hintsShown: Record<string, number>; // step id -> hints revealed so far
  coachHints: Record<string, string[]>; // per-step hints merged from the Coach agent
  briefing: string | null;
  finishedAt: number | null;
  start: (scenario: ForgeScenario, mode?: TrainingMode) => void;
  setMode: (mode: TrainingMode) => void;
  place: (partId: string, pose: Transform) => Verdict | null;
  complete: (stepId: string, evidence: StepEvidence) => Verdict | null;
  reset: () => void;
  done: () => boolean;
  setOperator: (operatorId: string | null, name?: string | null) => void;
  mergeCoach: (coach: { briefing?: string | null; hints?: Record<string, string[]> }) => void;
  showHint: (stepId: string) => string | null; // reveals the next hint for a step (cycles); null when there is none
  hintsFor: (stepId: string) => string[];
};

const uuid = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : "00000000-0000-4000-8000-" + Math.random().toString(16).slice(2, 14).padEnd(12, "0"));
const fresh = (scenario: ForgeScenario) => ({ run: createRun(scenario), sessionId: uuid(), lastVerdict: null, hintsShown: {}, finishedAt: null });

export const useForgeRun = create<ForgeRunStore>((set, get) => {
  const settle = (result: { verdict: Verdict; run: RunState }) => {
    const { scenario } = get();
    const finished = Boolean(scenario && isComplete(scenario, result.run));
    set((state) => ({ run: result.run, lastVerdict: result.verdict, verdictSeq: state.verdictSeq + 1, finishedAt: finished ? state.finishedAt ?? Date.now() : null }));
    return result.verdict;
  };
  return {
    scenario: null, run: null, mode: "3d", sessionId: null, lastVerdict: null, verdictSeq: 0, operatorId: null, operatorName: null,
    hintsShown: {}, coachHints: {}, briefing: null, finishedAt: null,
    start: (scenario, mode = get().mode) => set({ scenario, mode, coachHints: {}, briefing: null, ...fresh(scenario) }),
    setMode: (mode) => set({ mode }),
    place: (partId, pose) => {
      const { scenario, run } = get(); if (!scenario || !run) return null;
      return settle(attemptPlace(scenario, run, partId, pose));
    },
    complete: (stepId, evidence) => {
      const { scenario, run } = get(); if (!scenario || !run) return null;
      return settle(attemptStep(scenario, run, stepId, evidence));
    },
    reset: () => { const { scenario } = get(); if (scenario) set(fresh(scenario)); },
    done: () => { const { scenario, run } = get(); return Boolean(scenario && run && isComplete(scenario, run)); },
    setOperator: (operatorId, name = null) => set({ operatorId, operatorName: name }),
    mergeCoach: ({ briefing, hints }) => set((state) => {
      const merged = { ...state.coachHints };
      for (const [stepId, list] of Object.entries(hints ?? {})) merged[stepId] = Array.from(new Set([...(merged[stepId] ?? []), ...list.filter((hint) => typeof hint === "string" && hint.trim())]));
      return { coachHints: merged, briefing: briefing?.trim() ? briefing.trim() : state.briefing };
    }),
    hintsFor: (stepId) => {
      const { scenario, coachHints } = get();
      const step = scenario ? stepById(scenario, stepId) : null;
      if (!step) return [];
      const fromMistakes = (step.commonMistakes ?? []).map((mistake) => `Common mistake: ${mistake}.`);
      return Array.from(new Set([...(coachHints[stepId] ?? []), ...(step.hints ?? []), ...fromMistakes]));
    },
    showHint: (stepId) => {
      const hints = get().hintsFor(stepId);
      if (!hints.length) return null;
      const shown = get().hintsShown[stepId] ?? 0;
      set((state) => ({ hintsShown: { ...state.hintsShown, [stepId]: shown + 1 } }));
      return hints[shown % hints.length];
    },
  };
});
