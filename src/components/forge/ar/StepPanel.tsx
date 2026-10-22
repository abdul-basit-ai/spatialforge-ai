"use client";

import { useEffect, useMemo, useState } from "react";
import type { StepEvidence } from "@/lib/forge/engine";
import type { ForgeScenario, ForgeStep } from "@/lib/forge/types";
import { cx, styles } from "./shell";

// Step header + spec chips (tool, torque, pattern, target, warnings) shared by both AR modes.
export function StepHeader({ scenario, step, index }: { scenario: ForgeScenario; step: ForgeStep; index: number }) {
  return (
    <>
      <div className={styles.kicker}>Step {index + 1}<span>/ {scenario.steps.length}</span>· {step.kind}</div>
      <h2>{step.title}</h2>
      <p>{step.instruction}</p>
      <div className={styles.chips}>
        {step.tool && <span className={styles.chip}>Tool · {step.tool}</span>}
        {step.torqueNm !== undefined && <span className={cx(styles.chip, styles.amber)}>Torque · {step.torqueNm} N·m</span>}
        {step.pattern && <span className={styles.chip}>{step.pattern}</span>}
        {step.target && <span className={cx(styles.chip, styles.amber)}>{step.target.label} · {step.target.value} {step.target.unit}{step.target.tolerance ? ` ±${step.target.tolerance}` : ""}</span>}
        {step.warnings?.map((w) => <span key={w} className={cx(styles.chip, styles.red)}>Caution · {w}</span>)}
      </div>
    </>
  );
}

const GENERIC_TOOLS = ["Torque wrench", "3 mm hex key", "Phillips screwdriver", "Needle-nose pliers", "Snap-ring pliers", "Soft mallet", "Feeler gauge"];

// Evidence form for non-placement steps in AR training: tool choice, measured value, checklist, confirmation.
// The engine (attemptStep) judges it; this form only collects it.
export function EvidenceForm({ scenario, step, onSubmit }: { scenario: ForgeScenario; step: ForgeStep; onSubmit: (evidence: StepEvidence) => void }) {
  const [tool, setTool] = useState<string | null>(null);
  const [value, setValue] = useState("");
  const [checks, setChecks] = useState<boolean[]>([]);
  useEffect(() => { setTool(null); setValue(""); setChecks((step.checklist ?? []).map(() => false)); }, [step]);
  const tools = useMemo(() => {
    if (!step.tool) return [];
    const others = [...new Set([...scenario.steps.map((s) => s.tool).filter((t): t is string => Boolean(t)), ...GENERIC_TOOLS])].filter((t) => t.toLowerCase() !== step.tool!.toLowerCase());
    const seed = [...step.id].reduce((a, c) => a + c.charCodeAt(0), 0);
    const picks = [step.tool, others[seed % others.length], others[(seed + 3) % others.length]].filter((t, i, all) => t && all.indexOf(t) === i) as string[];
    return picks.sort((a, b) => ((a.length * 7 + seed) % 5) - ((b.length * 7 + seed) % 5));
  }, [scenario.steps, step]);
  const allChecked = checks.every(Boolean);
  const ready = (!step.tool || tool) && (!step.target || value.trim() !== "") && allChecked;
  const submit = () => onSubmit({ tool: tool ?? undefined, value: step.target && value.trim() !== "" ? Number(value) : undefined, checklist: checks.length ? checks : undefined, confirmed: true });
  const bump = (d: number) => { const base = Number(value || step.target?.value || 0); const k = step.target?.tolerance ?? Math.max(0.01, Math.abs(step.target?.value ?? 1) * 0.05); setValue(String(Math.round((base + d * k) * 1000) / 1000)); };
  return (
    <>
      {tools.length > 0 && <><div className={styles.muted} style={{ marginTop: 10 }}>Pick the tool</div><div className={styles.toolPick}>{tools.map((t) => <button key={t} type="button" className={cx(styles.chipBtn, tool === t && styles.on)} onClick={() => setTool(t)}>{t}</button>)}</div></>}
      {step.target && (
        <div className={styles.field}>
          <button type="button" className={styles.chipBtn} onClick={() => bump(-1)} aria-label="Decrease">−</button>
          <input inputMode="decimal" value={value} placeholder={`${step.target.label} (${step.target.unit})`} onChange={(e) => setValue(e.target.value.replace(/[^0-9.\-]/g, ""))} />
          <button type="button" className={styles.chipBtn} onClick={() => bump(1)} aria-label="Increase">+</button>
        </div>
      )}
      {step.checklist?.map((item, i) => (
        <label key={item} className={styles.check}><input type="checkbox" checked={checks[i] ?? false} onChange={(e) => setChecks((c) => c.map((v, j) => (j === i ? e.target.checked : v)))} />{item}</label>
      ))}
      <div className={styles.actions}><button type="button" className={cx(styles.btn, styles.primary)} disabled={!ready} onClick={submit}>{step.kind === "inspect" ? "Confirm inspection" : step.target ? "Set value" : "Complete step"}</button></div>
    </>
  );
}
