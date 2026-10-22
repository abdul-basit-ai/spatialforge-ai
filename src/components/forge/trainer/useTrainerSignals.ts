"use client";

import { useEffect, useRef } from "react";
import { stepById } from "@/lib/forge/engine";
import { useForgeRun } from "@/lib/forge/run-store";
import { trackForge } from "@/lib/forge/telemetry";
import type { ForgeEvent } from "@/lib/forge/types";
import { speak } from "@/lib/forge/voice-client";

// Voice + telemetry driven by run-store transitions, so every mode rendered inside the trainer (3D, AR training,
// AR assist) gets the same step announcements, spoken corrections and forge_* events without duplicating logic.
export function useTrainerSignals(options: { onAutoHint?: (stepId: string, hint: string) => void } = {}) {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  useEffect(() => useForgeRun.subscribe((state, prev) => {
    const { scenario, run, sessionId } = state;
    if (!scenario || !run || !sessionId) return;
    const base = { scenarioId: scenario.id, scenarioVersion: scenario.version, sessionId, operatorId: state.operatorId ?? "anonymous", mode: state.mode };
    const track = (event: Pick<ForgeEvent, "type"> & Partial<ForgeEvent>) => trackForge({ ...base, ...event });
    const now = Date.now();

    if (sessionId !== prev.sessionId) {
      track({ type: "forge_session_started" });
      const first = stepById(scenario, run.activeStepId);
      if (first) { track({ type: "forge_step_started", stepId: first.id }); void speak(first.voiceLine, { audioUrl: first.audio?.url }); }
      return;
    }
    const old = prev.run;
    if (!old || run === old) return;

    for (const stepId of run.completed.filter((id) => !old.completed.includes(id))) track({ type: "forge_step_completed", stepId, ms: now - old.stepStartedAt });
    const newMistakes = run.mistakes.slice(old.mistakes.length);
    const verdict = state.lastVerdict && !state.lastVerdict.ok ? state.lastVerdict : null;
    for (const mistake of newMistakes) {
      track({ type: "forge_mistake", stepId: mistake.stepId ?? undefined, partId: mistake.partId, reason: mistake.reason, message: verdict?.message, ms: now - run.stepStartedAt });
    }
    if (newMistakes.length && verdict) {
      void speak(verdict.message);
      const stepId = newMistakes.at(-1)?.stepId ?? run.activeStepId;
      const onStep = stepId ? run.mistakes.filter((mistake) => mistake.stepId === stepId).length : 0;
      // Adaptive help: after every second mistake on the same step, surface the next hint automatically.
      if (stepId && onStep >= 2 && onStep % 2 === 0) {
        const hint = useForgeRun.getState().showHint(stepId);
        if (hint) { track({ type: "forge_hint_shown", stepId, message: hint }); optionsRef.current.onAutoHint?.(stepId, hint); }
      }
    }
    if (run.activeStepId !== old.activeStepId && run.activeStepId) {
      const step = stepById(scenario, run.activeStepId);
      if (step) { track({ type: "forge_step_started", stepId: step.id }); void speak(step.voiceLine, { audioUrl: step.audio?.url }); }
    }
    if (state.finishedAt && !prev.finishedAt) {
      track({ type: "forge_session_completed", ms: state.finishedAt - run.startedAt });
      const mistakes = run.mistakes.length;
      void speak(`Assembly complete. ${mistakes === 0 ? "No mistakes. Excellent work." : `${mistakes} ${mistakes === 1 ? "correction" : "corrections"} along the way.`}`);
    }
  }), []);
}
