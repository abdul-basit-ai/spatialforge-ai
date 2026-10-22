"use client";

import { useEffect, useMemo, useState } from "react";
import * as THREE from "three";
import type { ForgePart, ForgeScenario, Mate, Quat, Vec3 } from "@/lib/forge/types";
import { AXIS_PRESETS, CATEGORIES, CATEGORY_COLORS, INSTALLING_KINDS, paramsFor, SHAPES, SYMMETRY_PRESETS, UNITLESS_PARAMS } from "./constants";
import { addPart, duplicatePart, patchPart, removePart, renamePart } from "./doc";
import { Field, NumberInput, Select, TextArea, TextInput, Toggle } from "./fields";

type Props = {
  doc: ForgeScenario;
  update: (fn: (doc: ForgeScenario) => ForgeScenario, coalesce?: string) => void;
  selectedPartId: string | null;
  onSelect: (id: string | null) => void;
  highlight: string[];
  partIssues?: Map<string, string[]>;
};

const toEuler = (q: Quat): Vec3 => { const e = new THREE.Euler().setFromQuaternion(new THREE.Quaternion(...q), "XYZ"); return [e.x, e.y, e.z].map((v) => Number(THREE.MathUtils.radToDeg(v).toFixed(3))) as Vec3; };
const toQuat = (deg: Vec3): Quat => { const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(...deg.map(THREE.MathUtils.degToRad) as Vec3, "XYZ")); return [q.x, q.y, q.z, q.w].map((v) => Number(v.toFixed(6))) as Quat; };
const shapeLabel = (part: ForgePart) => (part.geometry.kind === "mesh" ? "mesh" : part.geometry.shape);

export default function PartsPanel({ doc, update, selectedPartId, onSelect, highlight, partIssues }: Props) {
  const [filter, setFilter] = useState("");
  const installedBy = useMemo(() => {
    const map = new Map<string, string[]>();
    doc.steps.forEach((step, index) => { if (INSTALLING_KINDS.includes(step.kind)) step.partIds.forEach((id) => map.set(id, [...(map.get(id) ?? []), String(index + 1)])); });
    return map;
  }, [doc.steps]);
  const parts = doc.parts.filter((part) => !filter || `${part.name} ${part.id} ${part.category}`.toLowerCase().includes(filter.toLowerCase()));
  return <aside className="fe-panel fe-parts">
    <header className="fe-panel-head">
      <div><h3>Parts</h3><span className="fe-sub">{doc.parts.length} parts · {doc.baseParts.length} base</span></div>
      <button className="fe-btn is-small" onClick={() => { const result = addPart(doc); update(() => result.doc); onSelect(result.id); }}>+ Part</button>
    </header>
    <div className="fe-search"><input className="fe-input" placeholder="Filter parts…" value={filter} onChange={(event) => setFilter(event.target.value)} /></div>
    <div className="fe-table-head"><span /><span>Name</span><span>Category</span><span>Shape</span><span>Step</span></div>
    <div className="fe-scroll">
      {parts.map((part) => {
        const open = part.id === selectedPartId;
        const used = installedBy.get(part.id) ?? [];
        const base = doc.baseParts.includes(part.id);
        const problems = partIssues?.get(part.id) ?? [];
        return <div key={part.id} className={`fe-part${open ? " is-open" : ""}${highlight.includes(part.id) ? " is-highlight" : ""}`}>
          <button className="fe-part-row" onClick={() => onSelect(open ? null : part.id)}>
            <i className="fe-swatch" style={{ background: part.color ?? CATEGORY_COLORS[part.category] }} />
            <span className="fe-part-name">{part.name}<small>{part.id}{problems.length > 0 && <b className="fe-warn-text" title={problems.join("\n")}> · {problems.length} issue{problems.length > 1 ? "s" : ""}</b>}</small></span>
            <span className="fe-tag">{part.category}</span>
            <span className="fe-mono-dim">{shapeLabel(part)}</span>
            <span className="fe-mono-dim">{base ? <b className="fe-base">BASE</b> : used.length ? used.join(",") : <b className="fe-warn-text">—</b>}</span>
          </button>
          {open && <PartEditor doc={doc} part={part} update={update} onSelect={onSelect} base={base} issues={problems} />}
        </div>;
      })}
      {!parts.length && <div className="fe-empty-line">No parts match.</div>}
    </div>
  </aside>;
}

function PartEditor({ doc, part, update, onSelect, base, issues }: { doc: ForgeScenario; part: ForgePart; update: Props["update"]; onSelect: Props["onSelect"]; base: boolean; issues: string[] }) {
  const set = (patch: Partial<ForgePart>, key?: string) => update((d) => patchPart(d, part.id, patch), key && `${part.id}.${key}`);
  const setMate = (patch: Partial<Mate>, key?: string) => set({ mate: { ...part.mate, ...patch } }, key && `mate.${key}`);
  const [idDraft, setIdDraft] = useState(part.id);
  useEffect(() => setIdDraft(part.id), [part.id]);
  const euler = useMemo(() => toEuler(part.assembled.quaternion), [part.assembled.quaternion]);
  const axis = part.mate.axis;
  const axisLength = axis ? Math.hypot(...axis) : 1;
  const commitId = () => {
    const next = idDraft.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-");
    if (next && next !== part.id && !doc.parts.some((p) => p.id === next)) { update((d) => renamePart(d, part.id, next)); onSelect(next); } else setIdDraft(part.id);
  };
  const geometry = part.geometry;
  return <div className="fe-part-editor">
    {issues.length > 0 && <ul className="fe-inline-issues">{issues.map((issue) => <li key={issue}>{issue}</li>)}</ul>}
    <div className="fe-grid-2">
      <Field label="Name" wide><TextInput value={part.name} onChange={(name) => set({ name }, "name")} /></Field>
      <Field label="Id" hint="renames refs"><input className="fe-input is-mono" value={idDraft} onChange={(event) => setIdDraft(event.target.value)} onBlur={commitId} onKeyDown={(event) => event.key === "Enter" && commitId()} /></Field>
      <Field label="Category"><Select value={part.category} options={CATEGORIES.map((value) => ({ value, label: value }))} onChange={(category) => set({ category })} /></Field>
      <Field label="Color"><span className="fe-color"><input type="color" value={part.color ?? CATEGORY_COLORS[part.category]} onChange={(event) => set({ color: event.target.value }, "color")} /><TextInput mono value={part.color ?? ""} placeholder="auto" onChange={(color) => set({ color: color || undefined }, "colorText")} /></span></Field>
      <Field label="Start state"><Toggle checked={base} label={base ? "Base part (pre-placed)" : "Installed by a step"} onChange={(on) => update((d) => ({ ...d, baseParts: on ? [...d.baseParts, part.id] : d.baseParts.filter((id) => id !== part.id) }))} /></Field>
    </div>

    <div className="fe-subhead">Geometry</div>
    {geometry.kind === "mesh"
      ? <div className="fe-mesh-info"><span className="fe-tag is-cyan">CAD mesh</span><code>{geometry.assetId.slice(0, 8)}…</code><code>{geometry.node}</code></div>
      : <div className="fe-grid-3">
        <Field label="Shape"><Select value={geometry.shape} options={SHAPES.map((value) => ({ value, label: value }))} onChange={(shape) => set({ geometry: { ...geometry, shape } })} /></Field>
        {paramsFor(geometry.shape).map((key) => <Field key={key} label={key}>
          <NumberInput value={geometry.params[key]} scale={UNITLESS_PARAMS.has(key) ? 1 : 1000} step={UNITLESS_PARAMS.has(key) ? 1 : 0.5} unit={UNITLESS_PARAMS.has(key) ? "" : "mm"} allowEmpty onChange={(value) => { const params = { ...geometry.params }; if (value === undefined) delete params[key]; else params[key] = value; set({ geometry: { ...geometry, params } }, `param.${key}`); }} />
        </Field>)}
      </div>}

    <div className="fe-subhead">Assembled pose</div>
    <div className="fe-grid-3">
      {(["X", "Y", "Z"] as const).map((label, i) => <Field key={label} label={`Pos ${label}`}><NumberInput value={part.assembled.position[i]} scale={1000} step={0.5} unit="mm" onChange={(value) => { const position = [...part.assembled.position] as Vec3; position[i] = value ?? 0; set({ assembled: { ...part.assembled, position } }, `pos${i}`); }} /></Field>)}
      {(["X", "Y", "Z"] as const).map((label, i) => <Field key={label} label={`Rot ${label}`}><NumberInput value={euler[i]} step={5} unit="°" onChange={(value) => { const next = [...euler] as Vec3; next[i] = value ?? 0; set({ assembled: { ...part.assembled, quaternion: toQuat(next) } }, `rot${i}`); }} /></Field>)}
    </div>

    <div className="fe-subhead">Mate</div>
    <div className="fe-grid-3">
      <Field label="Type"><Select value={part.mate.type} options={[{ value: "fixed", label: "Fixed" }, { value: "axial", label: "Axial insert" }, { value: "planar", label: "Planar slide" }]} onChange={(type) => setMate({ type })} /></Field>
      <Field label="Position tol."><NumberInput value={part.mate.positionTolerance} scale={1000} step={0.5} unit="mm" min={0} onChange={(value) => setMate({ positionTolerance: value ?? 0 }, "ptol")} /></Field>
      <Field label="Angle tol."><NumberInput value={part.mate.angleToleranceDeg} step={1} unit="°" min={0} onChange={(value) => setMate({ angleToleranceDeg: value ?? 0 }, "atol")} /></Field>
    </div>
    <Field label="Insertion axis" hint="approach → seat">
      <div className="fe-axis">
        {AXIS_PRESETS.map((preset) => <button type="button" key={preset.label} className={`fe-chip${axis && preset.axis.every((v, i) => Math.abs(v - axis[i]) < 1e-6) ? " is-on" : ""}`} onClick={() => setMate({ axis: preset.axis })}>{preset.label}</button>)}
        <button type="button" className={`fe-chip${axis ? "" : " is-on"}`} onClick={() => setMate({ axis: undefined })}>none</button>
      </div>
    </Field>
    {axis && <div className="fe-grid-4">
      {(["x", "y", "z"] as const).map((label, i) => <Field key={label} label={label}><NumberInput value={axis[i]} step={0.1} onChange={(value) => { const next = [...axis] as Vec3; next[i] = value ?? 0; setMate({ axis: next }, `axis${i}`); }} /></Field>)}
      <Field label={Math.abs(axisLength - 1) > 0.05 ? "not unit!" : "unit"}><button type="button" className={`fe-btn is-small${Math.abs(axisLength - 1) > 0.05 ? " is-amber" : ""}`} disabled={!axisLength} onClick={() => setMate({ axis: axis.map((v) => Number((v / axisLength).toFixed(6))) as Vec3 })}>Normalize</button></Field>
    </div>}
    <Field label="Rotational symmetry" hint="about the axis">
      <div className="fe-grid-2">
        <Select value={SYMMETRY_PRESETS.some((preset) => preset.value === (part.mate.symmetryDeg ?? 360)) ? part.mate.symmetryDeg ?? 360 : -1} options={[...SYMMETRY_PRESETS, { value: -1, label: "Custom…" }]} onChange={(value) => value >= 0 && setMate({ symmetryDeg: value })} />
        <NumberInput value={part.mate.symmetryDeg ?? 360} step={15} unit="°" min={0} onChange={(value) => setMate({ symmetryDeg: value }, "sym")} />
      </div>
    </Field>
    <Field label="Description" wide><TextArea rows={2} value={part.description} placeholder="Part number, material, notes for the trainee" onChange={(description) => set({ description: description || undefined }, "desc")} /></Field>
    <div className="fe-row-actions">
      <button className="fe-btn is-small is-ghost" onClick={() => { const result = duplicatePart(doc, part.id); update(() => result.doc); onSelect(result.id); }}>Duplicate</button>
      <button className="fe-btn is-small is-danger" onClick={() => { if (confirm(`Remove ${part.name}? It is also removed from every step.`)) { update((d) => removePart(d, part.id)); onSelect(null); } }}>Remove part</button>
    </div>
  </div>;
}
