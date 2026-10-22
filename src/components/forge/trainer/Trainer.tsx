"use client";

import PartDock from "./PartDock";
import { useEffect, useMemo, useState } from "react";
import ForgeScene from "@/components/forge/ForgeScene";
import { ARAssist, ARTrainer } from "@/components/forge/ARModes";
import { dist, nextSteps, stepById } from "@/lib/forge/engine";
import { useForgeRun } from "@/lib/forge/run-store";
import { trackForge } from "@/lib/forge/telemetry";
import type { ForgePart, ForgeScenario, MistakeReason, StepKind, Transform, TrainingMode } from "@/lib/forge/types";
import { setVoiceEnabled, speak, stopSpeaking } from "@/lib/forge/voice-client";
import { clearLocalOperator, fetchCoach, fetchMe, fetchScenario, localOperator, type Operator } from "./data";
import { SignInGate } from "./SignInGate";
import { StepActions } from "./StepActions";
import { useTrainerSignals } from "./useTrainerSignals";

const MODES: Array<{ id: TrainingMode; label: string }> = [{ id: "3d", label: "3D" }, { id: "ar-train", label: "AR training" }, { id: "ar-assist", label: "AR assist" }];
const KIND_LABEL: Record<StepKind, string> = { place: "Place", fasten: "Fasten", connect: "Connect", route: "Route", adjust: "Adjust", inspect: "Inspect", tool: "Tool" };
const REASON_LABEL: Record<MistakeReason, string> = { "wrong-part": "Wrong part", "out-of-order": "Out of order", position: "Position", orientation: "Orientation", blocked: "Blocked", "wrong-tool": "Wrong tool", "out-of-range": "Out of range", "not-confirmed": "Not confirmed" };
const clock = (ms: number) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

export function Trainer({ id }: { id: string }) {
  const [scenario, setScenario] = useState<ForgeScenario | null>(null);
  const [from, setFrom] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [authAvailable, setAuthAvailable] = useState(false);
  const [operator, setOperator] = useState<Operator | null>(null);
  const [voiceOn, setVoiceOn] = useState(true);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [selectedPart, setSelectedPart] = useState<string | null>(null);
  const [hint, setHint] = useState<{ stepId: string; text: string; auto: boolean } | null>(null);
  const [toast, setToast] = useState<{ ok: boolean; text: string; reason?: MistakeReason; seq: number } | null>(null);
  const [, setTick] = useState(0);
  const { run, mode, lastVerdict, verdictSeq, briefing, hintsShown, finishedAt, coachHints } = useForgeRun();

  useTrainerSignals({ onAutoHint: (stepId, text) => setHint({ stepId, text, auto: true }) });

  useEffect(() => {
    const on = window.localStorage.getItem("forge.voice") !== "off";
    setVoiceOn(on); setVoiceEnabled(on);
    const timer = window.setInterval(() => setTick((value) => value + 1), 1000);
    return () => { window.clearInterval(timer); stopSpeaking(); };
  }, []);

  useEffect(() => {
    let live = true;
    setLoading(true);
    void Promise.all([fetchScenario(id), fetchMe()]).then(([loaded, auth]) => {
      if (!live) return;
      setScenario(loaded.scenario); setFrom(loaded.from);
      setAuthAvailable(auth.authAvailable);
      setOperator(auth.me ?? localOperator());
      setLoading(false);
    });
    return () => { live = false; };
  }, [id]);

  // Session start: once the scenario and the operator are known. Coach briefing + per-step hints are merged when they arrive.
  useEffect(() => {
    if (!scenario || !operator) return;
    const store = useForgeRun.getState();
    store.setOperator(operator.id, operator.name);
    store.start(scenario, "3d");
    setFocusId(null); setHint(null); setSelectedPart(null);
    let cancelled = false;
    void fetchCoach(scenario.id, operator.id).then((coach) => {
      if (cancelled || !coach) return;
      useForgeRun.getState().mergeCoach(coach);
      const state = useForgeRun.getState();
      if (coach.briefing && state.run && state.run.completed.length === 0) {
        const first = stepById(scenario, state.run.activeStepId);
        void speak(`${coach.briefing} ${first?.voiceLine ?? ""}`.trim());
      }
    });
    return () => { cancelled = true; };
  }, [scenario, operator]);

  // Toast for every verdict (the engine's message is the correction text).
  useEffect(() => {
    if (!verdictSeq || !lastVerdict || !scenario) return;
    const seq = verdictSeq;
    if (lastVerdict.ok) setToast({ ok: true, text: lastVerdict.done ? `${stepById(scenario, lastVerdict.stepId)?.title ?? "Step"} — done` : "Seated. Keep going.", seq });
    else setToast({ ok: false, text: lastVerdict.message, reason: lastVerdict.reason, seq });
    const timer = window.setTimeout(() => setToast((current) => (current?.seq === seq ? null : current)), lastVerdict.ok ? 1800 : 3800);
    return () => window.clearTimeout(timer);
  }, [verdictSeq, lastVerdict, scenario]);

  const available = useMemo(() => (scenario && run ? nextSteps(scenario, run) : []), [scenario, run]);
  const step = (scenario && (available.find((item) => item.id === focusId) ?? stepById(scenario, run?.activeStepId ?? null))) || null;
  const stepIndex = step && scenario ? scenario.steps.indexOf(step) : -1;
  const installs = step && ["place", "connect", "route"].includes(step.kind);
  const pending = useMemo(() => (step && run && installs ? step.partIds.filter((partId) => !run.installed.includes(partId)) : []), [step, run, installs]);
  const struggling = Boolean(step && run && ((hintsShown[step.id] ?? 0) > 0 || run.mistakes.some((mistake) => mistake.stepId === step.id)));
  const highlightIds = useMemo(() => (step ? (installs ? (struggling ? pending : []) : step.partIds) : []), [step, installs, struggling, pending]);
  useEffect(() => { setHint((current) => (current && step && current.stepId === step.id ? current : null)); }, [step]);

  const toggleVoice = () => { const next = !voiceOn; setVoiceOn(next); setVoiceEnabled(next); window.localStorage.setItem("forge.voice", next ? "on" : "off"); if (next && step) void speak(step.voiceLine, { audioUrl: step.audio?.url }); };
  const changeMode = (next: TrainingMode) => { useForgeRun.getState().setMode(next); stopSpeaking(); };
  const showHint = () => {
    if (!step) return;
    const state = useForgeRun.getState();
    const text = state.showHint(step.id) ?? (pending.length ? `Look for the cyan ghost: the ${scenario?.parts.find((part) => part.id === pending[0])?.name ?? "part"} seats there. Rotate with R, T and Y until the ghost turns green.` : step.instruction);
    setHint({ stepId: step.id, text, auto: false });
    if (state.scenario && state.sessionId) trackForge({ type: "forge_hint_shown", scenarioId: state.scenario.id, scenarioVersion: state.scenario.version, sessionId: state.sessionId, operatorId: state.operatorId ?? "anonymous", mode: state.mode, stepId: step.id, message: text, ms: run ? Date.now() - run.stepStartedAt : undefined });
    void speak(text);
  };
  // A drop counts as an attempt only near the assembly (its own seat or any open seat); setting a part down on the
  // bench is just rearranging. Whether an attempt is correct is decided by engine.attemptPlace via the store.
  const dropPart = (partId: string, pose: Transform) => {
    const state = useForgeRun.getState();
    if (!state.scenario || !state.run) return;
    const near = (target: ForgePart | undefined) => Boolean(target && dist(pose.position, target.assembled.position) <= Math.max(target.mate.positionTolerance * 5, 0.03));
    const open = state.scenario.parts.filter((part) => !state.run!.installed.includes(part.id));
    if (near(state.scenario.parts.find((part) => part.id === partId)) || open.some(near)) state.place(partId, pose);
  };
  const signOut = () => { clearLocalOperator(); stopSpeaking(); setOperator(null); };

  if (loading) return <div className="forge-app forge-center"><div className="forge-spinner" /><p>Loading scenario…</p></div>;
  if (!scenario) return <div className="forge-app forge-center"><h2>Scenario not found</h2><p>No scenario called “{id}”.</p><a className="forge-primary" href="/train">Back to scenarios</a></div>;

  const total = scenario.steps.length, done = run?.completed.length ?? 0;
  const elapsed = run ? (finishedAt ?? Date.now()) - run.startedAt : 0;
  const onStep = run && !finishedAt ? Date.now() - run.stepStartedAt : 0;
  const mistakes = run?.mistakes ?? [];
  const hintCount = step ? useForgeRun.getState().hintsFor(step.id).length : 0;
  const byReason = mistakes.reduce<Record<string, number>>((acc, mistake) => ({ ...acc, [mistake.reason]: (acc[mistake.reason] ?? 0) + 1 }), {});
  const hintsUsed = Object.values(hintsShown).reduce((sum, count) => sum + count, 0);
  const partName = (partId: string) => scenario.parts.find((part) => part.id === partId)?.name ?? partId;

  return (
    <div className="forge-app forge-trainer">
      <header className="forge-trainer-head">
        <div className="forge-trainer-title">
          <a href="/train" className="forge-back" aria-label="Back to scenarios">←</a>
          <div>
            <span className="forge-kicker">{scenario.domain} · v{scenario.version} · {scenario.source.kind}{from === "fixture" ? " · local fixture" : ""}{scenario.source.approximation ? " · AI-estimated" : ""}</span>
            <h1>{scenario.title}</h1>
          </div>
        </div>
        <div className="forge-trainer-controls">
          <div className="forge-modes" role="tablist" aria-label="Training mode">
            {MODES.map((item) => <button key={item.id} type="button" role="tab" aria-selected={mode === item.id} className={mode === item.id ? "is-active" : ""} disabled={!operator} onClick={() => changeMode(item.id)}>{item.label}</button>)}
          </div>
          <button type="button" className={`forge-toggle${voiceOn ? " is-on" : ""}`} onClick={toggleVoice} aria-pressed={voiceOn}><i aria-hidden />Voice {voiceOn ? "on" : "off"}</button>
          {operator && <span className="forge-operator" title={operator.source === "account" ? "Signed in" : "Device-local name"}><b>{operator.name}</b>{operator.source === "local" && <button type="button" onClick={signOut}>switch</button>}</span>}
        </div>
      </header>

      <div className="forge-progress" aria-label={`${done} of ${total} steps complete`}>
        <div className="forge-progress-bar">{scenario.steps.map((item) => <i key={item.id} className={run?.completed.includes(item.id) ? "is-done" : item.id === step?.id ? "is-current" : ""} />)}</div>
        <span>{done}/{total} steps · {clock(elapsed)} · {mistakes.length} {mistakes.length === 1 ? "mistake" : "mistakes"}</span>
      </div>

      {!operator ? (
        <SignInGate title={scenario.title} authAvailable={authAvailable} nextPath={`/train/${scenario.id}`} onReady={setOperator} />
      ) : (
        <div className="forge-trainer-grid">
          <section className={`forge-stage${toast && !toast.ok ? " is-mistake" : ""}`}>
            {mode === "3d" && <ForgeScene scenario={scenario} run={run} interactive scrambleStaging ghostPartIds={pending} highlightPartIds={highlightIds} selectedPartId={selectedPart} onPartSelect={setSelectedPart} onPartDrop={dropPart} />}
            {mode === "3d" && !finishedAt && <PartDock scenario={scenario} selectedPartId={selectedPart} onSelect={setSelectedPart} />}
            {mode === "ar-train" && <ARTrainer scenario={scenario} onExit={() => changeMode("3d")} />}
            {mode === "ar-assist" && <ARAssist scenario={scenario} onExit={() => changeMode("3d")} />}
            {toast && <div key={toast.seq} className={`forge-toast ${toast.ok ? "is-ok" : "is-bad"}`} role="status">{!toast.ok && toast.reason && <b>{REASON_LABEL[toast.reason]}</b>}<span>{toast.text}</span></div>}
            {finishedAt && run && (
              <div className="forge-complete">
                <div className="forge-complete-card">
                  <span className="forge-kicker">Assembly complete</span>
                  <h2>{scenario.title}</h2>
                  <div className="forge-complete-stats">
                    <div><strong>{clock(elapsed)}</strong><small>total time</small></div>
                    <div><strong className={mistakes.length ? "is-warn" : "is-good"}>{mistakes.length}</strong><small>mistakes</small></div>
                    <div><strong>{hintsUsed}</strong><small>hints</small></div>
                    <div><strong>{total}</strong><small>steps</small></div>
                  </div>
                  {mistakes.length > 0 && <ul className="forge-complete-reasons">{Object.entries(byReason).map(([reason, count]) => <li key={reason}><span>{REASON_LABEL[reason as MistakeReason] ?? reason}</span><b>{count}</b></li>)}</ul>}
                  <div className="forge-complete-actions">
                    <button type="button" className="forge-primary" onClick={() => { useForgeRun.getState().reset(); setFocusId(null); setHint(null); }}>Train again</button>
                    <a className="forge-secondary" href="/train">All scenarios</a>
                  </div>
                </div>
              </div>
            )}
          </section>

          <aside className="forge-panel">
            {briefing && <div className="forge-coach"><span className="forge-kicker">Coach briefing</span><p>{briefing}</p></div>}
            {step && !finishedAt ? (
              <div className="forge-step" key={step.id}>
                <div className="forge-step-head">
                  <span className={`forge-step-kind is-${step.kind}`}>{KIND_LABEL[step.kind]}</span>
                  <span>Step {stepIndex + 1} of {total}</span>
                  <span className="forge-step-timer">{clock(onStep)}</span>
                </div>
                <h2>{step.title}</h2>
                <p className="forge-step-text">{step.instruction}</p>
                {(step.tool || step.torqueNm !== undefined || step.pattern) && (
                  <dl className="forge-step-meta">
                    {step.tool && <div><dt>Tool</dt><dd>{step.tool}</dd></div>}
                    {step.torqueNm !== undefined && <div><dt>Torque</dt><dd>{step.torqueNm} N·m</dd></div>}
                    {step.pattern && <div><dt>Pattern</dt><dd>{step.pattern}</dd></div>}
                  </dl>
                )}
                {step.warnings?.map((warning) => <p key={warning} className="forge-warning">⚠ {warning}</p>)}
                <StepActions key={step.id} scenario={scenario} step={step} installed={run?.installed ?? []} onSelectPart={setSelectedPart} onSubmit={(evidence) => useForgeRun.getState().complete(step.id, evidence)} disabled={mode !== "3d" && Boolean(installs)} />
                <div className="forge-hint-row">
                  <button type="button" className="forge-secondary" onClick={showHint}>Hint{hintCount ? ` · ${hintCount}` : ""}{coachHints[step.id]?.length ? " · coach" : ""}</button>
                  {available.length > 1 && <span className="forge-note">{available.length - 1} other step{available.length > 2 ? "s" : ""} open in parallel</span>}
                </div>
                {hint && hint.stepId === step.id && <div className={`forge-hint${hint.auto ? " is-auto" : ""}`}><span className="forge-kicker">{hint.auto ? "Coach noticed you're stuck" : "Hint"}</span><p>{hint.text}</p></div>}
              </div>
            ) : finishedAt ? <div className="forge-step"><h2>All steps complete</h2><p className="forge-step-text">Every part is seated and checked.</p></div> : null}

            <div className="forge-steps">
              <span className="forge-label">Sequence</span>
              <ol>
                {scenario.steps.map((item, index) => {
                  const isDone = run?.completed.includes(item.id), isOpen = available.some((candidate) => candidate.id === item.id);
                  return (
                    <li key={item.id}>
                      <button type="button" disabled={!isOpen} className={`${isDone ? "is-done" : ""}${item.id === step?.id ? " is-current" : ""}${isOpen ? " is-open" : ""}`} onClick={() => setFocusId(item.id)}>
                        <span className="forge-steps-n">{isDone ? "✓" : index + 1}</span>
                        <span className="forge-steps-text"><strong>{item.title}</strong><small>{KIND_LABEL[item.kind]}{item.partIds.length ? ` · ${item.partIds.map(partName).join(", ")}` : ""}</small></span>
                      </button>
                    </li>
                  );
                })}
              </ol>
            </div>
            <div className="forge-panel-foot">
              <button type="button" className="forge-secondary" onClick={() => { useForgeRun.getState().reset(); setFocusId(null); setHint(null); }}>Restart run</button>
              <a className="forge-secondary" href={`/studio/${scenario.id}`}>Open in Studio</a>
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}
