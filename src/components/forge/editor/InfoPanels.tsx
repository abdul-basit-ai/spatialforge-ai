"use client";

import type { ForgeScenario, ForgeSource } from "@/lib/forge/types";
import { Field, Select, TextArea, TextInput, Toggle } from "./fields";

type Update = (fn: (doc: ForgeScenario) => ForgeScenario, coalesce?: string) => void;

// Maps validator messages back to the step or part they mention so the UI can badge and jump to them.
export function mapIssues(doc: ForgeScenario, issues: string[]) {
  const steps = new Map<string, string[]>(), parts = new Map<string, string[]>();
  const add = (map: Map<string, string[]>, id: string, issue: string) => map.set(id, [...(map.get(id) ?? []), issue]);
  const targets: Array<{ issue: string; stepId?: string; partId?: string }> = [];
  for (const issue of issues) {
    const step = doc.steps.find((s) => issue.startsWith(`Step "${s.title}"`) || issue.includes(`step id ${s.id}.`));
    const part = doc.parts.find((p) => issue.startsWith(`${p.name}:`) || issue.startsWith(`${p.name} is never`) || issue.startsWith(`Part ${p.id} `) || issue.includes(`part id ${p.id}.`));
    if (step) add(steps, step.id, issue);
    if (part) add(parts, part.id, issue);
    targets.push({ issue, stepId: step?.id, partId: part?.id });
  }
  return { steps, parts, targets };
}

export function IssuesPanel({ targets, onJump }: { targets: ReturnType<typeof mapIssues>["targets"]; onJump: (target: { stepId?: string; partId?: string }) => void }) {
  if (!targets.length) return <div className="fe-ok-state"><span className="fe-ok-icon">✓</span><div><b>Ready to publish</b><p>The deterministic validator found no issues: every part is installed once, every requirement exists, and there are no cycles.</p></div></div>;
  return <ul className="fe-issues">
    {targets.map((target, i) => <li key={i} className={target.stepId || target.partId ? "is-link" : ""} onClick={() => onJump(target)}>
      <span className="fe-issue-icon">!</span><span>{target.issue}</span>{(target.stepId || target.partId) && <span className="fe-issue-go">{target.stepId ? "step" : "part"} →</span>}
    </li>)}
  </ul>;
}

export function ScenarioPanel({ doc, update }: { doc: ForgeScenario; update: Update }) {
  return <div className="fe-grid-2 fe-pad">
    <Field label="Title" wide><TextInput value={doc.title} onChange={(title) => update((d) => ({ ...d, title }), "doc.title")} /></Field>
    <Field label="Summary" wide><TextArea rows={2} value={doc.summary} placeholder="One or two sentences shown on the scenario card" onChange={(summary) => update((d) => ({ ...d, summary }), "doc.summary")} /></Field>
    <Field label="Domain"><Select value={doc.domain} options={[{ value: "mechanical", label: "Mechanical" }, { value: "mechatronic", label: "Mechatronic" }]} onChange={(domain) => update((d) => ({ ...d, domain }))} /></Field>
    <Field label="Identity"><div className="fe-kv"><code>{doc.id}</code><span>v{doc.version}</span><span className={`fe-status is-${doc.status}`}>{doc.status}</span></div></Field>
    <Field label="Created"><span className="fe-mono-dim">{fmt(doc.createdAt)}</span></Field>
    <Field label="Updated"><span className="fe-mono-dim">{fmt(doc.updatedAt)}</span></Field>
  </div>;
}

export function SourcePanel({ doc, update }: { doc: ForgeScenario; update: Update }) {
  const source = doc.source;
  const set = (patch: Partial<ForgeSource>, key?: string) => update((d) => ({ ...d, source: { ...d.source, ...patch } }), key && `source.${key}`);
  const urls = source.urls ?? [];
  return <div className="fe-pad fe-source">
    <div className="fe-grid-2">
      <Field label="Origin"><Select value={source.kind} options={[{ value: "upload", label: "Uploaded files" }, { value: "web", label: "Web CAD" }, { value: "generated", label: "Generated (AI)" }, { value: "builtin", label: "Built-in" }]} onChange={(kind) => set({ kind })} /></Field>
      <Field label="Fidelity"><Toggle checked={source.approximation} label={source.approximation ? "Approximation: AI-estimated" : "Exact: from CAD/manual"} onChange={(approximation) => set({ approximation })} /></Field>
    </div>
    {source.approximation && <div className="fe-approx">⚠ Geometry or procedure is AI-estimated. Trainees see an approximation badge; verify torques and order against the real manual before publishing.</div>}
    {source.prompt && <Field label="Prompt" wide><div className="fe-quote">“{source.prompt}”</div></Field>}
    <Field label="Files" wide>
      {source.files?.length ? <ul className="fe-files">{source.files.map((file, i) => <li key={i}><span className="fe-tag">{file.mime.split("/").pop()}</span>{file.name}{file.assetId && <a className="fe-link" href={`/api/forge/assets/${file.assetId}`} target="_blank" rel="noreferrer">open</a>}</li>)}</ul> : <div className="fe-empty-line">No uploaded files.</div>}
    </Field>
    <Field label="Web sources & licenses" wide>
      <div className="fe-list">
        {urls.map((link, i) => <div className="fe-url-row" key={i}>
          <input className="fe-input" value={link.title} placeholder="Title" onChange={(event) => set({ urls: urls.map((u, j) => (j === i ? { ...u, title: event.target.value } : u)) }, `url${i}t`)} />
          <input className="fe-input is-mono" value={link.url} placeholder="https://" onChange={(event) => set({ urls: urls.map((u, j) => (j === i ? { ...u, url: event.target.value } : u)) }, `url${i}u`)} />
          <input className={`fe-input${link.license ? "" : " is-warn"}`} value={link.license ?? ""} placeholder="License (e.g. CC-BY 4.0)" onChange={(event) => set({ urls: urls.map((u, j) => (j === i ? { ...u, license: event.target.value || undefined } : u)) }, `url${i}l`)} />
          {/^https?:\/\//.test(link.url) && <a className="fe-icon-btn" href={link.url} target="_blank" rel="noreferrer" title="Open">↗</a>}
          <button className="fe-icon-btn is-danger" title="Remove" onClick={() => set({ urls: urls.filter((_, j) => j !== i) })}>×</button>
        </div>)}
        <button className="fe-add-line" onClick={() => set({ urls: [...urls, { title: "", url: "" }] })}>+ Add source</button>
      </div>
    </Field>
    <Field label="Notes" wide><TextArea rows={3} value={source.notes} placeholder="Provenance, assumptions, what was estimated" onChange={(notes) => set({ notes: notes || undefined }, "notes")} /></Field>
  </div>;
}

const fmt = (iso: string) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString(); };
