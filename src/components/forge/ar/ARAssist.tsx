"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { partById } from "@/lib/forge/engine";
import { speak } from "@/lib/forge/voice-client";
import { fileToJpeg } from "./camera";
import { DoneCard } from "./DoneCard";
import { ARFrame, cx, FeedbackLine, styles, useArStage } from "./shell";
import { StepHeader } from "./StepPanel";
import type { ARModeProps, VerifyResponse } from "./types";
import { useArRun } from "./useArRun";

const NUDGE = 0.005; // metres per tap
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// AR assist over REAL hardware: align the virtual base to the real object once, then each step shows a ghost of only
// that step's parts with an insertion arrow. "Check my work" sends a camera frame to /api/forge/verify-step.
// The vision verdict only advises; the step is recorded through the engine (place at the assembled pose / confirm).
export function ARAssist({ scenario, onExit, operatorId }: ARModeProps) {
  const ar = useArRun(scenario, "ar-assist", operatorId);
  const [phase, setPhase] = useState<"align" | "guide">("align");
  const [outline, setOutline] = useState(true);
  const [scale, setScale] = useState(1);
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<(VerifyResponse & { image?: string; stepId: string }) | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const shell = useArStage(scenario, "assist", {});
  const { stage, status, camera } = shell;
  const captureRef = useRef(camera.capture); captureRef.current = camera.capture;
  const { run, step } = ar;

  const ids = useMemo(() => (step ? step.partIds : []), [step]);
  useEffect(() => { stage?.setView({ run, ghostIds: phase === "guide" ? ids : [], arrowIds: phase === "guide" ? ids : [], outline: phase === "align" || outline, locked: phase === "guide" }); }, [stage, run, ids, phase, outline]);
  useEffect(() => { stage?.setScale(scale); }, [stage, scale]);
  useEffect(() => { setResult((r) => (r && r.stepId === step?.id ? r : null)); }, [step]);
  useEffect(() => { if (status.xr) setPhase("align"); }, [status.xr]);

  async function grabFrame(): Promise<string | null> {
    if (!stage) return null;
    if (status.xr) {
      const frame = await stage.captureXRFrame();
      if (frame) return frame;
      // No camera-access in this WebXR session: leave AR, let the rear camera come back, then snapshot it.
      ar.setFeedback({ tone: "info", text: "Switching to the camera view to take the photo.", at: Date.now() });
      stage.endXR();
    }
    for (let i = 0; i < 40; i++) { const shot = captureRef.current(); if (shot) return shot; await wait(150); }
    return null;
  }

  async function verify(image: string | null) {
    if (!step) return;
    if (!image) { setResult({ status: "unsure", confidence: 0, message: "No camera frame available. Take a photo instead, or confirm the step yourself.", observed: "", stepId: step.id }); return; }
    let data: VerifyResponse;
    try {
      const response = await fetch("/api/forge/verify-step", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scenarioId: scenario.id, version: scenario.version, stepId: step.id, image }) });
      data = await response.json() as VerifyResponse;
      if (!response.ok && !data.status) data = { status: "unsure", confidence: 0, message: data.error ?? `Check failed (${response.status}). Confirm the step yourself.`, observed: "" };
    } catch { data = { status: "unsure", confidence: 0, message: "Could not reach the checker. Confirm the step yourself.", observed: "" }; }
    setResult({ ...data, image, stepId: step.id });
    ar.emit("forge_vision_check", { stepId: step.id, message: `${data.status} ${Math.round((data.confidence ?? 0) * 100)}%: ${data.message}`.slice(0, 300) });
    if (data.status === "pass") {
      const verdict = ar.confirmStep(step);
      if (verdict?.ok) ar.setFeedback({ tone: "ok", text: data.message || "Looks right. Step recorded.", at: Date.now() });
    } else {
      // The result card shows the correction; clear any older banner so it is not shown twice.
      ar.setFeedback(null);
      void speak(data.status === "fail" ? data.message : `I'm not sure. ${data.message}`);
    }
  }

  const check = async () => { setChecking(true); try { await verify(await grabFrame().catch(() => null)); } finally { setChecking(false); } };
  const onPhoto = async (file?: File) => { if (!file) return; setChecking(true); try { await verify(await fileToJpeg(file).catch(() => null)); } finally { setChecking(false); } };
  const confirmManually = () => { if (!step) return; const verdict = ar.confirmStep(step); if (verdict?.ok) ar.setFeedback({ tone: "ok", text: "Confirmed. Step recorded.", at: Date.now() }); };

  const index = step ? scenario.steps.findIndex((s) => s.id === step.id) : -1;
  const partNames = ids.map((id) => partById(scenario, id)?.name).filter(Boolean).join(", ");
  const noCamera = !status.xr && (camera.state === "denied" || camera.state === "unavailable");

  const rail = phase === "align" ? (
    <>
      <label>Turn</label>
      <div style={{ display: "flex", gap: 6 }}>
        <button type="button" onClick={() => stage?.rotateAnchor(15)} aria-label="Rotate left 15 degrees">⟲</button>
        <button type="button" onClick={() => stage?.rotateAnchor(-15)} aria-label="Rotate right 15 degrees">⟳</button>
      </div>
      <label>Size {Math.round(scale * 100)}%</label>
      <div style={{ display: "flex", gap: 6 }}>
        <button type="button" onClick={() => setScale((s) => Math.max(0.2, Math.round(s * 0.95 * 1000) / 1000))} aria-label="Smaller">−</button>
        <button type="button" onClick={() => setScale((s) => Math.min(10, Math.round(s * 1.05 * 1000) / 1000))} aria-label="Larger">+</button>
      </div>
      <label>Nudge</label>
      <div className={styles.pad}>
        <button type="button" onClick={() => stage?.nudge(0, NUDGE, 0)} aria-label="Up">⤒</button>
        <button type="button" onClick={() => stage?.nudge(0, 0, -NUDGE)} aria-label="Away">↑</button>
        <button type="button" onClick={() => stage?.nudge(0, -NUDGE, 0)} aria-label="Down">⤓</button>
        <button type="button" onClick={() => stage?.nudge(-NUDGE, 0, 0)} aria-label="Left">←</button>
        <button type="button" onClick={() => { stage?.resetAnchor(); setScale(1); }} aria-label="Reset alignment" style={{ fontSize: 11 }}>RST</button>
        <button type="button" onClick={() => stage?.nudge(NUDGE, 0, 0)} aria-label="Right">→</button>
        <span />
        <button type="button" onClick={() => stage?.nudge(0, 0, NUDGE)} aria-label="Toward me">↓</button>
        <span />
      </div>
    </>
  ) : (
    <>
      <label>View</label>
      <button type="button" className={cx(outline && styles.on)} onClick={() => setOutline((o) => !o)} style={{ fontSize: 11 }}>Outline</button>
      <button type="button" onClick={() => setPhase("align")} style={{ fontSize: 11 }}>Re-align</button>
    </>
  );

  const center = phase === "align" && status.xr && !status.placed
    ? <span className={styles.prompt}>{status.surface ? "Point at the real part and tap to drop the outline" : "Move your phone slowly to find the surface"}</span>
    : null;

  const resultView = result && result.stepId === step?.id && (
    <div className={styles.result}>
      {result.image && <img className={styles.thumb} src={result.image} alt="Checked frame" />}
      <header><span className={styles[result.status]}>{result.status === "pass" ? "Pass" : result.status === "fail" ? "Needs a fix" : "Not sure"}</span>{result.status !== "unsure" && <span>{Math.round(result.confidence * 100)}% sure</span>}</header>
      {result.status !== "unsure" && <div className={styles.meter}><i style={{ width: `${Math.round(result.confidence * 100)}%`, background: result.status === "pass" ? "var(--ok)" : "var(--bad)" }} /></div>}
      <p>{result.message}</p>
      {result.observed && <p className={styles.muted}>Seen: {result.observed}</p>}
      {result.status === "unsure" && <p className={styles.muted}>If your work matches the ghost, confirm it yourself below.</p>}
      {result.status === "fail" && <p className={styles.muted}>Fix it, then check again.</p>}
    </div>
  );

  const sheet = !run ? <p className={styles.muted}>Preparing the assembly…</p> : ar.done || !step ? <DoneCard scenario={scenario} run={run} onRestart={() => { ar.restart(); setPhase("guide"); }} onExit={onExit} /> : phase === "align" ? (
    <>
      <div className={styles.kicker}>Align · once per session</div>
      <h2>Line the outline up with your real {partById(scenario, scenario.baseParts[0] ?? null)?.name ?? "base part"}</h2>
      <p>{status.xr ? "Tap the surface to drop the outline on the real part, then turn, resize and nudge until the edges match." : "Drag the outline over the real part in the camera view, then turn, resize and nudge until the edges match."}</p>
      <FeedbackLine feedback={ar.feedback} />
      <div className={styles.actions}><button type="button" className={cx(styles.btn, styles.primary)} disabled={!status.placed} onClick={() => setPhase("guide")}>Lock alignment</button></div>
    </>
  ) : (
    <>
      <StepHeader scenario={scenario} step={step} index={index} />
      {partNames && <div className={styles.chips}><span className={cx(styles.chip, styles.amber)}>Ghost · {partNames}</span></div>}
      <FeedbackLine feedback={ar.feedback} />
      {resultView}
      <div className={styles.actions}>
        <button type="button" className={cx(styles.btn, styles.primary)} disabled={checking || noCamera} onClick={() => void check()}>{checking ? <><i className={styles.spinner} />Checking</> : "Check my work"}</button>
        <button type="button" className={cx(styles.btn, noCamera && styles.cyan)} disabled={checking} onClick={() => fileRef.current?.click()}>Take photo</button>
      </div>
      <div className={styles.actions}>
        <button type="button" className={cx(styles.btn, result?.status === "unsure" ? styles.cyan : styles.ghost)} disabled={checking} onClick={confirmManually}>{result?.status === "unsure" ? "Looks right, confirm" : "Confirm manually"}</button>
        <button type="button" className={cx(styles.btn, styles.ghost)} onClick={ar.hint}>Hint</button>
      </div>
      <input ref={fileRef} type="file" accept="image/*" capture="environment" hidden onChange={(e) => { void onPhoto(e.target.files?.[0]); e.target.value = ""; }} />
    </>
  );

  return <ARFrame shell={shell} title={scenario.title} kicker="AR assist · real hardware" progress={{ done: run?.completed.length ?? 0, total: scenario.steps.length }} onExit={onExit} rail={rail} center={center} sheet={sheet} />;
}
