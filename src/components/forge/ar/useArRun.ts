"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { isComplete, stepById, type StepEvidence, type Verdict } from "@/lib/forge/engine";
import { useForgeRun } from "@/lib/forge/run-store";
import { trackForge } from "@/lib/forge/telemetry";
import type { ForgeEvent, ForgeScenario, ForgeStep, Transform, TrainingMode } from "@/lib/forge/types";
import { speak } from "@/lib/forge/voice-client";

export type Feedback = { tone: "ok" | "bad" | "info" | "warn"; text: string; at: number } | null;
export const PLACE_KINDS = ["place", "connect", "route"];

// Shared run wiring for both AR modes: joins (or starts) the shared useForgeRun session, voices each new step,
// turns engine verdicts into feedback + speech, and emits Forge telemetry for AR-originated actions.
export function useArRun(scenario: ForgeScenario, mode: TrainingMode, operatorId = "guest") {
  const run = useForgeRun((s) => s.run);
  const sessionId = useForgeRun((s) => s.sessionId);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [mistakesOnStep, setMistakesOnStep] = useState(0);
  const spokenStep = useRef<string | null>(null);
  const finished = useRef(false);

  useEffect(() => {
    const s = useForgeRun.getState();
    if (!s.run || s.scenario?.id !== scenario.id || s.scenario.version !== scenario.version) s.start(scenario, mode);
    else s.setMode(mode);
  }, [scenario, mode]);

  const emit = useCallback((type: ForgeEvent["type"], extra: Partial<ForgeEvent> = {}) => {
    const id = useForgeRun.getState().sessionId; if (!id) return;
    trackForge({ type, scenarioId: scenario.id, scenarioVersion: scenario.version, sessionId: id, operatorId, mode, ...extra });
  }, [scenario.id, scenario.version, operatorId, mode]);

  const step: ForgeStep | null = run ? stepById(scenario, run.activeStepId) : null;
  const done = Boolean(run && isComplete(scenario, run));

  // Voice + telemetry on every new active step.
  useEffect(() => {
    if (!step || spokenStep.current === step.id) return;
    spokenStep.current = step.id; setMistakesOnStep(0);
    emit("forge_step_started", { stepId: step.id });
    void speak(step.voiceLine || step.instruction, { audioUrl: step.audio?.url });
  }, [step, emit]);

  useEffect(() => {
    if (!done || finished.current || !run) return;
    finished.current = true;
    emit("forge_session_completed", { ms: Date.now() - run.startedAt });
    setFeedback({ tone: "ok", text: "Assembly complete. Nice work.", at: Date.now() });
    void speak("Assembly complete. Nice work.");
  }, [done, run, emit]);
  useEffect(() => { if (!done) finished.current = false; }, [done]);

  // Success banners fade after a few seconds; mistakes stay until the next action.
  useEffect(() => {
    if (feedback?.tone !== "ok" || done) return;
    const at = feedback.at, timer = setTimeout(() => setFeedback((f) => (f?.at === at ? null : f)), 3500);
    return () => clearTimeout(timer);
  }, [feedback, done]);

  const react = useCallback((verdict: Verdict | null, partId?: string, quietSuccess = false) => {
    if (!verdict) return verdict;
    const before = useForgeRun.getState().run;
    if (verdict.ok) {
      if (verdict.done) {
        emit("forge_step_completed", { stepId: verdict.stepId, partId, ms: before ? Date.now() - before.stepStartedAt : undefined });
        setFeedback({ tone: "ok", text: "Step complete.", at: Date.now() });
      } else {
        setFeedback({ tone: "ok", text: "Seated. Next part.", at: Date.now() });
        if (!quietSuccess) void speak("Good. Next part.");
      }
    } else {
      emit("forge_mistake", { stepId: verdict.stepId, partId, reason: verdict.reason, message: verdict.message });
      setMistakesOnStep((n) => n + 1);
      setFeedback({ tone: "bad", text: verdict.message, at: Date.now() });
      void speak(verdict.message);
    }
    return verdict;
  }, [emit]);

  const place = useCallback((partId: string, pose: Transform, quiet = false) => react(useForgeRun.getState().place(partId, pose), partId, quiet), [react]);
  const complete = useCallback((stepId: string, evidence: StepEvidence) => react(useForgeRun.getState().complete(stepId, evidence)), [react]);

  // Completes the active step as a human-confirmed action (AR assist pass / manual confirm). Places missing parts at
  // their assembled pose first, so the engine records them as installed.
  const confirmStep = useCallback((target: ForgeStep) => {
    let current = useForgeRun.getState().run;
    if (PLACE_KINDS.includes(target.kind)) {
      for (const id of target.partIds) {
        if (current?.installed.includes(id)) continue;
        const part = scenario.parts.find((p) => p.id === id); if (!part) continue;
        const verdict = place(id, part.assembled, true);
        if (!verdict?.ok) return verdict;
        current = useForgeRun.getState().run;
      }
      if (current?.completed.includes(target.id)) return { ok: true as const, stepId: target.id, done: true };
    }
    return complete(target.id, { confirmed: true });
  }, [scenario.parts, place, complete]);

  const hint = useCallback(() => {
    if (!step) return;
    const text = step.hints?.[Math.min(mistakesOnStep, (step.hints?.length ?? 1) - 1)] ?? step.instruction;
    emit("forge_hint_shown", { stepId: step.id, message: text });
    setFeedback({ tone: "info", text, at: Date.now() });
    void speak(text);
  }, [step, mistakesOnStep, emit]);

  const restart = useCallback(() => { useForgeRun.getState().reset(); spokenStep.current = null; setFeedback(null); }, []);

  return { run, sessionId, step, done, feedback, setFeedback, mistakesOnStep, place, complete, confirmStep, hint, restart, emit };
}
