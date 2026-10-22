"use client";

import { useEffect, useState, type ReactNode } from "react";

// Small form controls for the studio editor. Number fields keep a local draft so typing "0." or "-" is not clobbered.

export function Field({ label, hint, children, wide }: { label: string; hint?: string; children: ReactNode; wide?: boolean }) {
  return <label className={`fe-field${wide ? " is-wide" : ""}`}><span className="fe-label">{label}{hint && <em>{hint}</em>}</span>{children}</label>;
}

export function TextInput({ value, onChange, placeholder, mono }: { value: string | undefined; onChange: (value: string) => void; placeholder?: string; mono?: boolean }) {
  return <input className={`fe-input${mono ? " is-mono" : ""}`} value={value ?? ""} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />;
}

export function TextArea({ value, onChange, placeholder, rows = 3, max }: { value: string | undefined; onChange: (value: string) => void; placeholder?: string; rows?: number; max?: number }) {
  const length = (value ?? "").length;
  return <div className="fe-textarea-wrap">
    <textarea className="fe-input fe-textarea" rows={rows} value={value ?? ""} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />
    {max && <span className={`fe-count${length > max ? " is-over" : ""}`}>{length}/{max}</span>}
  </div>;
}

// value is in storage units; scale converts to display units (e.g. 1000 for metres shown as millimetres).
export function NumberInput({ value, onChange, scale = 1, step, unit, placeholder, allowEmpty, min }: { value: number | undefined; onChange: (value: number | undefined) => void; scale?: number; step?: number; unit?: string; placeholder?: string; allowEmpty?: boolean; min?: number }) {
  const format = (v: number | undefined) => (v === undefined || !Number.isFinite(v) ? "" : String(Number((v * scale).toPrecision(6))));
  const [draft, setDraft] = useState(format(value));
  const [focused, setFocused] = useState(false);
  useEffect(() => { if (!focused) setDraft(format(value)); }, [value, focused]); // eslint-disable-line react-hooks/exhaustive-deps
  const commit = (text: string) => {
    setDraft(text);
    if (text.trim() === "") { if (allowEmpty) onChange(undefined); return; }
    const parsed = Number(text);
    if (Number.isFinite(parsed)) onChange(parsed / scale);
  };
  return <span className="fe-number">
    <input className="fe-input is-mono" inputMode="decimal" type="number" step={step} min={min} value={draft} placeholder={placeholder} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} onChange={(event) => commit(event.target.value)} />
    {unit && <span className="fe-unit">{unit}</span>}
  </span>;
}

export function Select<T extends string | number>({ value, options, onChange }: { value: T; options: ReadonlyArray<{ value: T; label: string }>; onChange: (value: T) => void }) {
  return <select className="fe-input fe-select" value={String(value)} onChange={(event) => { const match = options.find((option) => String(option.value) === event.target.value); if (match) onChange(match.value); }}>
    {options.map((option) => <option key={String(option.value)} value={String(option.value)}>{option.label}</option>)}
  </select>;
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (value: boolean) => void; label: string }) {
  return <button type="button" className={`fe-toggle${checked ? " is-on" : ""}`} aria-pressed={checked} onClick={() => onChange(!checked)}><span className="fe-toggle-knob" />{label}</button>;
}

// Toggleable chips for multi-select (part ids, required steps).
export function Chips({ options, selected, onChange, empty }: { options: Array<{ value: string; label: string; color?: string; disabled?: boolean }>; selected: string[]; onChange: (value: string[]) => void; empty?: string }) {
  if (!options.length) return <div className="fe-empty-line">{empty ?? "Nothing to choose."}</div>;
  const missing = selected.filter((id) => !options.some((option) => option.value === id));
  return <div className="fe-chips">
    {options.map((option) => {
      const on = selected.includes(option.value);
      return <button type="button" key={option.value} disabled={option.disabled && !on} className={`fe-chip${on ? " is-on" : ""}`} style={on && option.color ? { borderColor: option.color, boxShadow: `inset 0 0 0 1px ${option.color}55`, color: "var(--fe-text)" } : undefined} onClick={() => onChange(on ? selected.filter((id) => id !== option.value) : [...selected, option.value])}>
        {option.color && <i style={{ background: option.color }} />}{option.label}
      </button>;
    })}
    {missing.map((id) => <button type="button" key={id} className="fe-chip is-on is-missing" title="Unknown id: click to remove" onClick={() => onChange(selected.filter((value) => value !== id))}>⚠ {id} ×</button>)}
  </div>;
}

// Editable list of strings (checklist, warnings, hints, mistakes).
export function StringList({ values, onChange, placeholder }: { values: string[] | undefined; onChange: (values: string[] | undefined) => void; placeholder?: string }) {
  const list = values ?? [];
  const set = (next: string[]) => onChange(next.length ? next : undefined);
  return <div className="fe-list">
    {list.map((value, index) => <div className="fe-list-row" key={index}>
      <span className="fe-list-index">{index + 1}</span>
      <input className="fe-input" value={value} placeholder={placeholder} onChange={(event) => set(list.map((item, i) => (i === index ? event.target.value : item)))} />
      <button type="button" className="fe-icon-btn" title="Move up" disabled={index === 0} onClick={() => { const next = [...list]; [next[index - 1], next[index]] = [next[index], next[index - 1]]; set(next); }}>↑</button>
      <button type="button" className="fe-icon-btn is-danger" title="Remove" onClick={() => set(list.filter((_, i) => i !== index))}>×</button>
    </div>)}
    <button type="button" className="fe-add-line" onClick={() => onChange([...list, ""])}>+ Add</button>
  </div>;
}

export function Section({ title, children, aside, defaultOpen = true }: { title: string; children: ReactNode; aside?: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return <section className={`fe-section${open ? " is-open" : ""}`}>
    <header className="fe-section-head" onClick={() => setOpen(!open)}><span className="fe-caret">{open ? "▾" : "▸"}</span><h4>{title}</h4>{aside && <span className="fe-section-aside" onClick={(event) => event.stopPropagation()}>{aside}</span>}</header>
    {open && <div className="fe-section-body">{children}</div>}
  </section>;
}
