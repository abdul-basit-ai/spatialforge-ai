"use client";

import { useMemo, useState } from "react";
import type { StepEvidence } from "@/lib/forge/engine";
import type { ForgeScenario, ForgeStep } from "@/lib/forge/types";

// Per-kind controls for a step. They only collect evidence; correctness is judged by engine.attemptStep / attemptPlace.
type Props = { scenario: ForgeScenario; step: ForgeStep; installed: string[]; onSubmit: (evidence: StepEvidence) => void; onSelectPart: (partId: string) => void; disabled?: boolean };

const TOOL_POOL = ["2 mm hex key", "2.5 mm hex key", "3 mm hex key", "4 mm hex key", "5 mm hex key", "1.5 mm hex key", "T20 Torx driver", "T25 Torx driver", "PH2 screwdriver", "flat screwdriver", "7 mm nut driver", "8 mm spanner", "10 mm spanner", "13 mm socket", "torque wrench", "torque screwdriver", "snap-ring pliers", "needle-nose pliers", "wire stripper", "crimp tool", "feeler gauge", "digital caliper", "dial indicator", "rubber mallet", "bearing press", "multimeter", "cable ties", "thread locker"];

const seeded = (text: string) => { let h = 2166136261; for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619); return () => ((h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0) % 10000) / 10000; };
const family = (tool: string) => tool.toLowerCase().replace(/[\d.,]+\s*(mm|nm)?/g, "").replace(/\s+/g, " ").trim();

// Plausible distractors: same tool family first (other hex sizes), then a few unrelated tools. Stable per step.
export function toolOptions(step: ForgeStep, count = 5): string[] {
  if (!step.tool) return [];
  const right = step.tool, rand = seeded(step.id + right);
  const pool = TOOL_POOL.filter((tool) => tool.toLowerCase() !== right.toLowerCase());
  const same = pool.filter((tool) => family(tool) === family(right)).sort(() => rand() - 0.5).slice(0, 2);
  const other = pool.filter((tool) => !same.includes(tool)).sort(() => rand() - 0.5).slice(0, count - 1 - same.length);
  return [right, ...same, ...other].sort(() => rand() - 0.5);
}

function ToolPicker({ step, value, onPick, label = "Choose the tool" }: { step: ForgeStep; value: string | null; onPick: (tool: string) => void; label?: string }) {
  const options = useMemo(() => toolOptions(step), [step]);
  return (
    <div className="forge-tools">
      <span className="forge-label">{label}</span>
      <div className="forge-tool-grid">
        {options.map((tool) => <button key={tool} type="button" className={`forge-tool${value === tool ? " is-picked" : ""}`} onClick={() => onPick(tool)}><i aria-hidden>⚒</i>{tool}</button>)}
      </div>
    </div>
  );
}

export function StepActions({ scenario, step, installed, onSubmit, onSelectPart, disabled }: Props) {
  const [tool, setTool] = useState<string | null>(null);
  const target = step.target;
  const tolerance = target ? target.tolerance ?? Math.abs(target.value) * 0.1 : 0;
  const span = target ? Math.max(tolerance * 8, Math.abs(target.value) * 0.8, 1) : 1;
  const min = target ? +(target.value - span).toFixed(3) : 0, max = target ? +(target.value + span).toFixed(3) : 1;
  const [value, setValue] = useState(() => (target ? +(target.value - span * 0.55).toFixed(3) : 0));
  const [checks, setChecks] = useState<boolean[]>(() => (step.checklist ?? []).map(() => false));
  const partName = (id: string) => scenario.parts.find((part) => part.id === id)?.name ?? id;

  if (step.kind === "place" || step.kind === "connect" || step.kind === "route") {
    return (
      <div className="forge-actions">
        <span className="forge-label">{step.kind === "connect" ? "Connect" : step.kind === "route" ? "Route" : "Place"} — drag onto the cyan ghost</span>
        <div className="forge-part-chips">
          {step.partIds.map((id) => {
            const done = installed.includes(id);
            return <button key={id} type="button" className={`forge-chip${done ? " is-done" : ""}`} disabled={done} onClick={() => onSelectPart(id)}>{done ? "✓ " : "◎ "}{partName(id)}</button>;
          })}
        </div>
        {step.tool && <p className="forge-note">Tool: <b>{step.tool}</b></p>}
      </div>
    );
  }

  if (step.kind === "tool") {
    return <div className="forge-actions"><ToolPicker step={step} value={tool} onPick={(picked) => { setTool(picked); if (!disabled) onSubmit({ tool: picked }); }} label="Pick the right tool for this step" /></div>;
  }

  if (step.kind === "fasten") {
    return (
      <div className="forge-actions">
        {step.tool && <ToolPicker step={step} value={tool} onPick={setTool} />}
        <div className="forge-torque">
          <div className="forge-torque-dial" aria-hidden><span>{step.torqueNm ?? "—"}</span><small>N·m</small></div>
          <div><span className="forge-label">Torque</span><strong>{step.torqueNm !== undefined ? `${step.torqueNm} N·m` : "Snug tight"}</strong><p className="forge-note">{step.pattern ?? "Tighten evenly."}</p></div>
        </div>
        <button type="button" className="forge-primary" disabled={disabled || Boolean(step.tool && !tool)} onClick={() => onSubmit({ tool: tool ?? undefined, confirmed: true })}>
          {step.tool && !tool ? "Pick a tool first" : `Fastened${step.torqueNm !== undefined ? ` to ${step.torqueNm} N·m` : ""} — confirm`}
        </button>
      </div>
    );
  }

  if (step.kind === "adjust" && target) {
    return (
      <div className="forge-actions">
        {step.tool && <ToolPicker step={step} value={tool} onPick={setTool} />}
        <span className="forge-label">{target.label} · spec {target.value} {target.unit} ± {+tolerance.toFixed(3)}</span>
        <div className="forge-adjust">
          <input type="range" min={min} max={max} step={Math.max(tolerance / 4, 0.001)} value={value} onChange={(event) => setValue(Number(event.target.value))} />
          <label className="forge-adjust-value"><input type="number" step={Math.max(tolerance / 4, 0.001)} value={value} onChange={(event) => setValue(Number(event.target.value))} /><span>{target.unit}</span></label>
        </div>
        <button type="button" className="forge-primary" disabled={disabled || Boolean(step.tool && !tool)} onClick={() => onSubmit({ value, tool: tool ?? undefined })}>{step.tool && !tool ? "Pick a tool first" : `Set ${target.label.toLowerCase()} to ${value} ${target.unit}`}</button>
      </div>
    );
  }

  if (step.kind === "inspect" && step.checklist?.length) {
    const all = checks.every(Boolean);
    return (
      <div className="forge-actions">
        <span className="forge-label">Inspection checklist</span>
        <ul className="forge-checklist">
          {step.checklist.map((item, i) => (
            <li key={item}><label className={checks[i] ? "is-checked" : ""}><input type="checkbox" checked={checks[i] ?? false} onChange={(event) => setChecks((list) => list.map((v, j) => (j === i ? event.target.checked : v)))} /><span>{item}</span></label></li>
          ))}
        </ul>
        <button type="button" className="forge-primary" disabled={disabled} onClick={() => onSubmit({ checklist: checks, confirmed: all })}>{all ? "Pass inspection" : `Pass inspection (${checks.filter(Boolean).length}/${checks.length} checked)`}</button>
      </div>
    );
  }

  return (
    <div className="forge-actions">
      {step.tool && <ToolPicker step={step} value={tool} onPick={setTool} />}
      <button type="button" className="forge-primary" disabled={disabled || Boolean(step.tool && !tool)} onClick={() => onSubmit({ tool: tool ?? undefined, confirmed: true })}>Done — confirm step</button>
    </div>
  );
}
