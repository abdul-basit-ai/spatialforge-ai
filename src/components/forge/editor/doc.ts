"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import type { ForgePart, ForgeScenario, ForgeStep } from "@/lib/forge/types";
import { blankStep, CATEGORY_COLORS } from "./constants";

// Editor document state with undo/redo, plus pure scenario operations that keep ids and references consistent.

type History = { doc: ForgeScenario | null; past: ForgeScenario[]; future: ForgeScenario[]; saved: string };
const LIMIT = 120;
// Content identity: server-managed metadata (timestamps, version, status, issues) does not make the document dirty.
export const fingerprint = (doc: ForgeScenario | null) => (doc ? JSON.stringify({ ...doc, updatedAt: "", createdAt: "", version: 0, status: "", issues: undefined }) : "");

export function useScenarioDoc() {
  const [state, setState] = useState<History>({ doc: null, past: [], future: [], saved: "" });
  const last = useRef<{ key: string; at: number } | null>(null);
  // coalesce: consecutive edits with the same key within a second merge into one undo step (typing in a field).
  const update = useCallback((fn: (doc: ForgeScenario) => ForgeScenario, coalesce?: string) => {
    setState((s) => {
      if (!s.doc) return s;
      const next = fn(s.doc);
      if (next === s.doc) return s;
      const now = Date.now();
      const merge = coalesce && last.current?.key === coalesce && now - last.current.at < 1000;
      last.current = coalesce ? { key: coalesce, at: now } : null;
      return { ...s, doc: next, past: merge ? s.past : [...s.past, s.doc].slice(-LIMIT), future: [] };
    });
  }, []);
  const load = useCallback((doc: ForgeScenario, saved = true) => setState({ doc, past: [], future: [], saved: saved ? fingerprint(doc) : "" }), []);
  // After a save round-trip: adopt the server copy when nothing changed meanwhile, otherwise keep the newer edits (still dirty).
  const markSaved = useCallback((saved: ForgeScenario, sent: string) => setState((s) => {
    if (!s.doc) return s;
    if (fingerprint(s.doc) === sent) return { ...s, doc: saved, saved: fingerprint(saved) };
    return { ...s, doc: { ...s.doc, version: saved.version, status: saved.status, createdAt: saved.createdAt, updatedAt: saved.updatedAt }, saved: sent };
  }), []);
  const undo = useCallback(() => setState((s) => (s.doc && s.past.length ? { ...s, doc: s.past.at(-1)!, past: s.past.slice(0, -1), future: [s.doc, ...s.future] } : s)), []);
  const redo = useCallback(() => setState((s) => (s.doc && s.future.length ? { ...s, doc: s.future[0], past: [...s.past, s.doc], future: s.future.slice(1) } : s)), []);
  const dirty = useMemo(() => Boolean(state.doc) && fingerprint(state.doc) !== state.saved, [state.doc, state.saved]);
  return { doc: state.doc, update, load, markSaved, undo, redo, canUndo: state.past.length > 0, canRedo: state.future.length > 0, dirty };
}

export const uniqueId = (base: string, taken: Iterable<string>) => {
  const used = new Set(taken);
  const root = base.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50) || "item";
  if (!used.has(root)) return root;
  for (let i = 2; ; i++) if (!used.has(`${root}-${i}`)) return `${root}-${i}`;
};

export const patchPart = (doc: ForgeScenario, id: string, patch: Partial<ForgePart>): ForgeScenario => ({ ...doc, parts: doc.parts.map((part) => (part.id === id ? { ...part, ...patch } : part)) });
export const patchStep = (doc: ForgeScenario, id: string, patch: Partial<ForgeStep>): ForgeScenario => ({ ...doc, steps: doc.steps.map((step) => (step.id === id ? { ...step, ...patch } : step)) });

export function addPart(doc: ForgeScenario): { doc: ForgeScenario; id: string } {
  const id = uniqueId("part", doc.parts.map((part) => part.id));
  const part: ForgePart = { id, name: `New part ${doc.parts.length + 1}`, category: "structural", color: CATEGORY_COLORS.structural, geometry: { kind: "primitive", shape: "box", params: { width: 0.03, height: 0.02, depth: 0.03 } }, assembled: { position: [0, 0.03, 0], quaternion: [0, 0, 0, 1] }, mate: { type: "axial", axis: [0, -1, 0], positionTolerance: 0.004, angleToleranceDeg: 10, symmetryDeg: 360 } };
  return { doc: { ...doc, parts: [...doc.parts, part] }, id };
}

export function duplicatePart(doc: ForgeScenario, id: string): { doc: ForgeScenario; id: string } {
  const index = doc.parts.findIndex((part) => part.id === id);
  if (index < 0) return { doc, id };
  const source = doc.parts[index];
  const copyId = uniqueId(`${source.id}-copy`, doc.parts.map((part) => part.id));
  const p = source.assembled.position;
  const copy: ForgePart = { ...structuredClone(source), id: copyId, name: `${source.name} (copy)`, assembled: { position: [p[0] + 0.01, p[1], p[2] + 0.01], quaternion: source.assembled.quaternion } };
  const parts = [...doc.parts]; parts.splice(index + 1, 0, copy);
  return { doc: { ...doc, parts }, id: copyId };
}

export function removePart(doc: ForgeScenario, id: string): ForgeScenario {
  return { ...doc, parts: doc.parts.filter((part) => part.id !== id), baseParts: doc.baseParts.filter((value) => value !== id), steps: doc.steps.map((step) => ({ ...step, partIds: step.partIds.filter((value) => value !== id) })) };
}

export function renamePart(doc: ForgeScenario, from: string, to: string): ForgeScenario {
  if (!to || from === to || doc.parts.some((part) => part.id === to)) return doc;
  const swap = (ids: string[]) => ids.map((value) => (value === from ? to : value));
  return { ...doc, parts: doc.parts.map((part) => (part.id === from ? { ...part, id: to } : part)), baseParts: swap(doc.baseParts), steps: doc.steps.map((step) => ({ ...step, partIds: swap(step.partIds) })) };
}

export function addStep(doc: ForgeScenario, afterId?: string | null): { doc: ForgeScenario; id: string } {
  const id = uniqueId(`s${doc.steps.length + 1}`, doc.steps.map((step) => step.id));
  const index = afterId ? doc.steps.findIndex((step) => step.id === afterId) : doc.steps.length - 1;
  const previous = doc.steps[index];
  const step = { ...blankStep(id), requires: previous ? [previous.id] : [] };
  const steps = [...doc.steps]; steps.splice(index + 1, 0, step);
  return { doc: { ...doc, steps }, id };
}

export function duplicateStep(doc: ForgeScenario, id: string): { doc: ForgeScenario; id: string } {
  const index = doc.steps.findIndex((step) => step.id === id);
  if (index < 0) return { doc, id };
  const source = doc.steps[index];
  const copyId = uniqueId(`${source.id}-copy`, doc.steps.map((step) => step.id));
  // An installing copy would install the same parts twice; clear them so the author picks new ones.
  const copy: ForgeStep = { ...structuredClone(source), id: copyId, title: `${source.title} (copy)`, requires: [source.id], partIds: ["place", "connect", "route"].includes(source.kind) ? [] : [...source.partIds], audio: undefined };
  const steps = [...doc.steps]; steps.splice(index + 1, 0, copy);
  return { doc: { ...doc, steps }, id: copyId };
}

export function removeStep(doc: ForgeScenario, id: string): ForgeScenario {
  const removed = doc.steps.find((step) => step.id === id);
  // Steps that depended on the removed one inherit its requirements so the chain stays connected.
  return { ...doc, steps: doc.steps.filter((step) => step.id !== id).map((step) => (step.requires.includes(id) ? { ...step, requires: Array.from(new Set([...step.requires.filter((value) => value !== id), ...(removed?.requires ?? [])])) } : step)) };
}

export function renameStep(doc: ForgeScenario, from: string, to: string): ForgeScenario {
  if (!to || from === to || doc.steps.some((step) => step.id === to)) return doc;
  return { ...doc, steps: doc.steps.map((step) => ({ ...step, id: step.id === from ? to : step.id, requires: step.requires.map((value) => (value === from ? to : value)) })) };
}

export function moveStep(doc: ForgeScenario, id: string, toIndex: number): ForgeScenario {
  const from = doc.steps.findIndex((step) => step.id === id);
  if (from < 0) return doc;
  const target = Math.max(0, Math.min(doc.steps.length - 1, toIndex));
  if (from === target) return doc;
  const steps = [...doc.steps]; const [step] = steps.splice(from, 1); steps.splice(target, 0, step);
  return { ...doc, steps };
}

// Every step requires the one before it (a simple linear procedure).
export const linearize = (doc: ForgeScenario): ForgeScenario => ({ ...doc, steps: doc.steps.map((step, index) => ({ ...step, requires: index ? [doc.steps[index - 1].id] : [] })) });

// Drop requirements that point at later steps (after a reorder) so the order shown is the order trained.
export const dropForwardRequires = (doc: ForgeScenario): ForgeScenario => ({ ...doc, steps: doc.steps.map((step, index) => ({ ...step, requires: step.requires.filter((id) => doc.steps.findIndex((other) => other.id === id) < index && doc.steps.some((other) => other.id === id)) })) });

// Parts installed before the given step runs (base parts plus earlier installing steps, in list order).
export function installedBefore(doc: ForgeScenario, stepId: string): string[] {
  const installed = new Set(doc.baseParts);
  for (const step of doc.steps) {
    if (step.id === stepId) break;
    if (["place", "connect", "route"].includes(step.kind)) step.partIds.forEach((id) => installed.add(id));
  }
  return [...installed];
}
