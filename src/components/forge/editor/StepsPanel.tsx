"use client";

import { useEffect, useState } from "react";
import { speak, stopSpeaking } from "@/lib/forge/voice-client";
import type { ForgeScenario, ForgeStep, StepKind } from "@/lib/forge/types";
import { CATEGORY_COLORS, INSTALLING_KINDS, KIND_META, LIST_FIELDS, STEP_KINDS } from "./constants";
import { addStep, dropForwardRequires, duplicateStep, linearize, moveStep, patchStep, removeStep, renameStep } from "./doc";
import { Chips, Field, NumberInput, Section, Select, StringList, TextArea, TextInput } from "./fields";

type Props = {
  doc: ForgeScenario;
  update: (fn: (doc: ForgeScenario) => ForgeScenario, coalesce?: string) => void;
  selectedStepId: string | null;
  onSelect: (id: string | null) => void;
  stepIssues: Map<string, string[]>;
};

export default function StepsPanel({ doc, update, selectedStepId, onSelect, stepIssues }: Props) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const selected = doc.steps.find((step) => step.id === selectedStepId) ?? null;
  const index = selected ? doc.steps.indexOf(selected) : -1;
  const drop = (target: number) => { if (dragId) update((d) => moveStep(d, dragId, target > d.steps.findIndex((s) => s.id === dragId) ? target - 1 : target)); setDragId(null); setOverIndex(null); };
  return <aside className="fe-panel fe-steps">
    <header className="fe-panel-head">
      <div><h3>Procedure</h3><span className="fe-sub">{doc.steps.length} steps</span></div>
      <div className="fe-head-actions">
        <button className="fe-btn is-small is-ghost" title="Every step requires the one before it" onClick={() => update(linearize)}>Linear chain</button>
        <button className="fe-btn is-small" onClick={() => { const result = addStep(doc, selectedStepId); update(() => result.doc); onSelect(result.id); }}>+ Step</button>
      </div>
    </header>
    <ol className="fe-step-list" onDragOver={(event) => event.preventDefault()}>
      {doc.steps.map((step, i) => {
        const meta = KIND_META[step.kind];
        const issues = stepIssues.get(step.id)?.length ?? 0;
        return <li key={step.id} draggable onDragStart={(event) => { setDragId(step.id); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", step.id); }}
          onDragOver={(event) => { event.preventDefault(); const rect = event.currentTarget.getBoundingClientRect(); setOverIndex(event.clientY > rect.top + rect.height / 2 ? i + 1 : i); }}
          onDrop={(event) => { event.preventDefault(); drop(overIndex ?? i); }} onDragEnd={() => { setDragId(null); setOverIndex(null); }}
          className={`fe-step${step.id === selectedStepId ? " is-selected" : ""}${dragId === step.id ? " is-dragging" : ""}${overIndex === i ? " drop-before" : ""}${overIndex === i + 1 && i === doc.steps.length - 1 ? " drop-after" : ""}`}
          onClick={() => onSelect(step.id === selectedStepId ? null : step.id)}>
          <span className="fe-grip" title="Drag to reorder">⋮⋮</span>
          <span className="fe-step-num">{String(i + 1).padStart(2, "0")}</span>
          <span className="fe-kind" style={{ color: meta.color, borderColor: `${meta.color}66` }}>{meta.label}</span>
          <span className="fe-step-title">{step.title || <em>Untitled</em>}<small>{step.partIds.length ? `${step.partIds.length} part${step.partIds.length > 1 ? "s" : ""}` : "no parts"}{step.requires.length ? ` · after ${step.requires.map((id) => doc.steps.findIndex((s) => s.id === id) + 1 || "?").join(", ")}` : ""}{step.audio?.url ? " · voiced" : ""}</small></span>
          {issues > 0 && <span className="fe-issue-dot" title={stepIssues.get(step.id)!.join("\n")}>{issues}</span>}
          <span className="fe-step-move" onClick={(event) => event.stopPropagation()}>
            <button className="fe-icon-btn" title="Move up" disabled={i === 0} onClick={() => update((d) => moveStep(d, step.id, i - 1))}>↑</button>
            <button className="fe-icon-btn" title="Move down" disabled={i === doc.steps.length - 1} onClick={() => update((d) => moveStep(d, step.id, i + 1))}>↓</button>
          </span>
        </li>;
      })}
      {!doc.steps.length && <li className="fe-empty-line">No steps yet. Add the first one.</li>}
    </ol>
    {selected
      ? <StepEditor key={selected.id} doc={doc} step={selected} index={index} update={update} onSelect={onSelect} issues={stepIssues.get(selected.id) ?? []} />
      : <div className="fe-step-placeholder">Select a step to edit it. Drag steps to reorder; the preview shows the assembly state before the selected step.</div>}
  </aside>;
}

function StepEditor({ doc, step, index, update, onSelect, issues }: { doc: ForgeScenario; step: ForgeStep; index: number; update: Props["update"]; onSelect: Props["onSelect"]; issues: string[] }) {
  const set = (patch: Partial<ForgeStep>, key?: string) => update((d) => patchStep(d, step.id, patch), key && `${step.id}.${key}`);
  const [idDraft, setIdDraft] = useState(step.id);
  const [playing, setPlaying] = useState(false);
  useEffect(() => () => stopSpeaking(), []);
  const commitId = () => {
    const next = idDraft.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-");
    if (next && next !== step.id && !doc.steps.some((s) => s.id === next)) { update((d) => renameStep(d, step.id, next)); onSelect(next); } else setIdDraft(step.id);
  };
  const installs = INSTALLING_KINDS.includes(step.kind);
  const installedElsewhere = new Map<string, number>();
  doc.steps.forEach((other, i) => { if (other.id !== step.id && INSTALLING_KINDS.includes(other.kind)) other.partIds.forEach((id) => installedElsewhere.set(id, i + 1)); });
  const play = async () => { setPlaying(true); try { await speak(step.voiceLine || step.instruction, { audioUrl: step.audio?.url }); } finally { setTimeout(() => setPlaying(false), 600); } };
  const meta = KIND_META[step.kind];
  return <div className="fe-step-editor">
    <div className="fe-editor-title">
      <span className="fe-step-num is-big">{String(index + 1).padStart(2, "0")}</span>
      <input className="fe-title-input" value={step.title} placeholder="Step title" onChange={(event) => set({ title: event.target.value }, "title")} />
    </div>
    {issues.length > 0 && <ul className="fe-inline-issues">{issues.map((issue) => <li key={issue}>{issue}</li>)}</ul>}
    <div className="fe-grid-2">
      <Field label="Kind" hint={meta.hint}><Select<StepKind> value={step.kind} options={STEP_KINDS.map((value) => ({ value, label: KIND_META[value].label }))} onChange={(kind) => set({ kind })} /></Field>
      <Field label="Step id"><input className="fe-input is-mono" value={idDraft} onChange={(event) => setIdDraft(event.target.value)} onBlur={commitId} onKeyDown={(event) => event.key === "Enter" && commitId()} /></Field>
    </div>
    <Field label="Instruction" hint="on screen" wide><TextArea rows={3} value={step.instruction} placeholder="What the trainee does, precisely" onChange={(instruction) => set({ instruction }, "instruction")} /></Field>
    <Field label="Voice line" hint="ElevenLabs · short, imperative" wide>
      <div className="fe-voice">
        <TextArea rows={2} max={160} value={step.voiceLine} placeholder="Spoken aloud for this step" onChange={(voiceLine) => set({ voiceLine, audio: undefined }, "voice")} />
        <div className="fe-voice-actions">
          <button className={`fe-btn is-small is-cyan${playing ? " is-pulse" : ""}`} disabled={!step.voiceLine.trim() && !step.instruction.trim()} onClick={play}>▶ Play voice</button>
          {!step.voiceLine.trim() && step.instruction.trim() && <button className="fe-btn is-small is-ghost" onClick={() => set({ voiceLine: step.instruction.split(/(?<=[.!?])\s/)[0].slice(0, 140) })}>Use first sentence</button>}
          {step.audio?.url && <span className="fe-tag is-cyan" title={step.audio.url}>cached audio</span>}
        </div>
      </div>
    </Field>
    <Field label={installs ? "Parts installed" : "Parts acted on"} hint={installs ? "required" : "optional"} wide>
      <Chips selected={step.partIds} onChange={(partIds) => set({ partIds })} empty="Add parts first."
        options={doc.parts.map((part) => { const elsewhere = installs ? installedElsewhere.get(part.id) : undefined; const base = doc.baseParts.includes(part.id); return { value: part.id, label: `${part.name}${base && installs ? " (base)" : elsewhere ? ` (step ${elsewhere})` : ""}`, color: part.color ?? CATEGORY_COLORS[part.category], disabled: installs && (base || elsewhere !== undefined) }; })} />
    </Field>
    <Field label="Requires" hint="steps finished first" wide>
      <Chips selected={step.requires} onChange={(requires) => set({ requires })} empty="This is the only step."
        options={doc.steps.filter((other) => other.id !== step.id).map((other) => ({ value: other.id, label: `${doc.steps.indexOf(other) + 1}. ${other.title}`, color: doc.steps.indexOf(other) > index ? "#f87171" : undefined }))} />
      <div className="fe-row-actions is-left">
        {index > 0 && <button className="fe-link" onClick={() => set({ requires: [doc.steps[index - 1].id] })}>Only the previous step</button>}
        {step.requires.length > 0 && <button className="fe-link" onClick={() => set({ requires: [] })}>None (can start any time)</button>}
        <button className="fe-link" onClick={() => update(dropForwardRequires)}>Drop all forward requirements</button>
      </div>
    </Field>

    <Section title="Tooling" defaultOpen={Boolean(step.tool || step.torqueNm || step.pattern) || step.kind === "fasten" || step.kind === "tool"}>
      <div className="fe-grid-3">
        <Field label="Tool"><TextInput value={step.tool} placeholder="e.g. 3 mm hex key" onChange={(tool) => set({ tool: tool || undefined }, "tool")} /></Field>
        <Field label="Torque"><NumberInput value={step.torqueNm} step={0.1} unit="N·m" allowEmpty min={0} onChange={(torqueNm) => set({ torqueNm }, "torque")} /></Field>
        <Field label="Pattern"><TextInput value={step.pattern} placeholder="cross pattern, two passes" onChange={(pattern) => set({ pattern: pattern || undefined }, "pattern")} /></Field>
      </div>
    </Section>
    <Section title="Target value" defaultOpen={Boolean(step.target) || step.kind === "adjust"} aside={step.target ? <button className="fe-link is-danger" onClick={() => set({ target: undefined })}>clear</button> : <button className="fe-link" onClick={() => set({ target: { label: "Gap", value: 1, unit: "mm", tolerance: 0.2 } })}>+ add</button>}>
      {step.target ? <div className="fe-grid-4">
        <Field label="Label"><TextInput value={step.target.label} onChange={(label) => set({ target: { ...step.target!, label } }, "tlabel")} /></Field>
        <Field label="Value"><NumberInput value={step.target.value} step={0.1} onChange={(value) => set({ target: { ...step.target!, value: value ?? 0 } }, "tvalue")} /></Field>
        <Field label="Unit"><TextInput mono value={step.target.unit} onChange={(unit) => set({ target: { ...step.target!, unit } }, "tunit")} /></Field>
        <Field label="± Tol."><NumberInput value={step.target.tolerance} step={0.05} allowEmpty placeholder="10%" onChange={(tolerance) => set({ target: { ...step.target!, tolerance } }, "ttol")} /></Field>
      </div> : <div className="fe-empty-line">No measured target. Adjust steps compare the trainee&apos;s reading to this value.</div>}
    </Section>
    {LIST_FIELDS.map((field) => <Section key={field.key} title={field.label} aside={<span className="fe-count-pill">{step[field.key]?.length ?? 0}</span>} defaultOpen={Boolean(step[field.key]?.length) || (field.key === "checklist" && step.kind === "inspect")}>
      <StringList values={step[field.key]} placeholder={field.placeholder} onChange={(values) => set({ [field.key]: values } as Partial<ForgeStep>, field.key)} />
    </Section>)}
    <div className="fe-row-actions">
      <button className="fe-btn is-small is-ghost" onClick={() => { const result = duplicateStep(doc, step.id); update(() => result.doc); onSelect(result.id); }}>Duplicate</button>
      <button className="fe-btn is-small is-ghost" onClick={() => { const result = addStep(doc, step.id); update(() => result.doc); onSelect(result.id); }}>Insert after</button>
      <button className="fe-btn is-small is-danger" onClick={() => { const next = doc.steps[index + 1] ?? doc.steps[index - 1]; update((d) => removeStep(d, step.id)); onSelect(next?.id ?? null); }}>Delete step</button>
    </div>
  </div>;
}
