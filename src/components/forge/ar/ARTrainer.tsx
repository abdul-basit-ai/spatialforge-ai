"use client";

import { useEffect, useMemo, useState } from "react";
import { partById } from "@/lib/forge/engine";
import type { ARModeProps } from "./types";
import { ARFrame, cx, FeedbackLine, styles, useArStage } from "./shell";
import { DoneCard } from "./DoneCard";
import { EvidenceForm, StepHeader } from "./StepPanel";
import { PLACE_KINDS, useArRun } from "./useArRun";

const SCALES = [1, 2, 5];

// AR training with no real hardware: virtual parts on a real table (WebXR) or over the camera feed (screen-locked).
export function ARTrainer({ scenario, onExit, operatorId }: ARModeProps) {
  const ar = useArRun(scenario, "ar-train", operatorId);
  const [selected, setSelected] = useState<string | null>(null);
  const [scale, setScale] = useState(1);
  const shell = useArStage(scenario, "train", { onSelect: setSelected, onDrop: (id, pose) => ar.place(id, pose) });
  const { stage, status } = shell;
  const { run, step } = ar;

  const placing = Boolean(step && PLACE_KINDS.includes(step.kind) && run && step.partIds.some((id) => !run.installed.includes(id)));
  const ghostIds = useMemo(() => (placing && step && run ? step.partIds.filter((id) => !run.installed.includes(id)) : []), [placing, step, run]);
  const arrowIds = useMemo(() => (step ? (placing ? (ar.mistakesOnStep > 0 ? ghostIds : []) : step.partIds) : []), [step, placing, ar.mistakesOnStep, ghostIds]);
  useEffect(() => { stage?.setView({ run, ghostIds, arrowIds, outline: false, locked: true }); }, [stage, run, ghostIds, arrowIds]);
  useEffect(() => { stage?.setScale(scale); }, [stage, scale]);

  const index = step ? scenario.steps.findIndex((s) => s.id === step.id) : -1;
  const selectedPart = partById(scenario, selected);
  const nextName = ghostIds.map((id) => partById(scenario, id)?.name).filter(Boolean).join(", ");

  const center = status.xr && !status.placed
    ? <span className={styles.prompt}>{status.surface ? "Tap to place the assembly here" : "Move your phone slowly to find the table"}</span>
    : status.dragging && status.snapId ? <span className={styles.prompt} style={{ borderColor: "var(--amber)" }}>Release to seat</span> : null;

  const rail = (
    <>
      <label>Scale</label>
      {SCALES.map((s) => <button key={s} type="button" className={cx(scale === s && styles.on)} onClick={() => setScale(s)}>{s}×</button>)}
      <label>Rotate</label>
      <button type="button" disabled={!selectedPart} onClick={() => stage?.rotateSelected(-90)} aria-label="Rotate selected part minus 90 degrees">⟲ 90</button>
      <button type="button" disabled={!selectedPart} onClick={() => stage?.rotateSelected(90)} aria-label="Rotate selected part 90 degrees">⟳ 90</button>
    </>
  );

  const sheet = !run ? <p className={styles.muted}>Preparing the assembly…</p> : ar.done || !step ? (
    <DoneCard scenario={scenario} run={run} onRestart={ar.restart} onExit={onExit} />
  ) : (
    <>
      <StepHeader scenario={scenario} step={step} index={index} />
      {placing && (
        <div className={styles.chips}>
          <span className={cx(styles.chip, styles.amber)}>Next part · {nextName}</span>
          {selectedPart && <span className={styles.chip}>Holding · {selectedPart.name}</span>}
        </div>
      )}
      <FeedbackLine feedback={ar.feedback} />
      {placing ? (
        <>
          <p className={styles.muted} style={{ marginTop: 10 }}>{status.xr ? "Touch a part, drag it onto the cyan ghost and let go." : "Drag a part onto the cyan ghost and let go. Drag empty space to look around; pinch or scroll to zoom."} Use ⟲ / ⟳ to turn the held part.</p>
          <div className={styles.actions}>
            <button type="button" className={cx(styles.btn, styles.cyan)} onClick={ar.hint}>Hint</button>
            <button type="button" className={cx(styles.btn, styles.ghost)} onClick={ar.restart}>Restart</button>
          </div>
        </>
      ) : (
        <>
          <EvidenceForm scenario={scenario} step={step} onSubmit={(evidence) => ar.complete(step.id, evidence)} />
          <div className={styles.actions}><button type="button" className={cx(styles.btn, styles.ghost)} onClick={ar.hint}>Hint</button></div>
        </>
      )}
    </>
  );

  const total = scenario.steps.length;
  return <ARFrame shell={shell} title={scenario.title} kicker="AR training" progress={{ done: run?.completed.length ?? 0, total }} onExit={onExit} rail={rail} center={center} sheet={sheet} />;
}
