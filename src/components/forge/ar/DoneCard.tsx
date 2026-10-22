"use client";

import type { RunState } from "@/lib/forge/engine";
import type { ForgeScenario } from "@/lib/forge/types";
import { cx, styles } from "./shell";

export function DoneCard({ scenario, run, onRestart, onExit }: { scenario: ForgeScenario; run: RunState | null; onRestart: () => void; onExit: () => void }) {
  const seconds = run ? Math.max(1, Math.round((Date.now() - run.startedAt) / 1000)) : 0;
  const time = seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
  return (
    <div className={styles.doneCard}>
      <div className={styles.kicker} style={{ justifyContent: "center" }}>Assembly complete</div>
      <h2>{scenario.title}</h2>
      <div className={styles.stats}>
        <div><strong>{scenario.steps.length}</strong><small>Steps</small></div>
        <div><strong>{run?.mistakes.length ?? 0}</strong><small>Mistakes</small></div>
        <div><strong>{time}</strong><small>Time</small></div>
      </div>
      <div className={styles.actions}>
        <button type="button" className={cx(styles.btn, styles.primary)} onClick={onRestart}>Run it again</button>
        <button type="button" className={cx(styles.btn, styles.ghost)} onClick={onExit}>Back to 3D</button>
      </div>
    </div>
  );
}
