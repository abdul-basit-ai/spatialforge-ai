"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RunState } from "@/lib/forge/engine";
import type { ForgeScenario } from "@/lib/forge/types";
import { validateScenario } from "@/lib/forge/validate";
import { setVoiceEnabled } from "@/lib/forge/voice-client";
import { INSTALLING_KINDS, KIND_META } from "./constants";
import { fingerprint, installedBefore, useScenarioDoc } from "./doc";
import { IssuesPanel, mapIssues, ScenarioPanel, SourcePanel } from "./InfoPanels";
import PartsPanel from "./PartsPanel";
import StepsPanel from "./StepsPanel";
import { blankScenario, demoScenario } from "./templates";
import "./editor.css";

const ForgeScene = dynamic(() => import("@/components/forge/ForgeScene"), { ssr: false, loading: () => <div className="fe-scene-loading">Loading 3D preview…</div> });

const TOKEN_KEY = "forge-admin-token";
type Toast = { id: number; tone: "ok" | "warn" | "error"; text: string };
type Meta = { builtin: boolean; stored: boolean; publishedVersion: number };

// Debounced copy of a value: the 3D preview rebuilds only after edits settle, not on every keystroke.
function useSettled<T>(value: T, key: string, ms = 280): T {
  const [settled, setSettled] = useState(value);
  const latest = useRef(value); latest.current = value;
  useEffect(() => { const timer = setTimeout(() => setSettled(latest.current), ms); return () => clearTimeout(timer); }, [key, ms]);
  return settled;
}

export default function ScenarioEditor({ id }: { id: string }) {
  const { doc, update, load, markSaved, undo, redo, canUndo, canRedo, dirty } = useScenarioDoc();
  const [phase, setPhase] = useState<"loading" | "ready" | "missing" | "error">("loading");
  const [loadError, setLoadError] = useState("");
  const [meta, setMeta] = useState<Meta>({ builtin: false, stored: false, publishedVersion: 0 });
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const [selectedPartId, setSelectedPartId] = useState<string | null>(null);
  const [exploded, setExploded] = useState(false);
  const [stepView, setStepView] = useState(true);
  const [tab, setTab] = useState<"issues" | "scenario" | "source">("issues");
  const [busy, setBusy] = useState<"" | "save" | "publish">("");
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [tokenPrompt, setTokenPrompt] = useState<{ message: string } | null>(null);
  const [tokenDraft, setTokenDraft] = useState("");
  const [voiceOn, setVoiceOn] = useState(true);

  const toast = useCallback((tone: Toast["tone"], text: string) => {
    const entry = { id: Date.now() + Math.random(), tone, text };
    setToasts((list) => [...list.slice(-3), entry]);
    setTimeout(() => setToasts((list) => list.filter((item) => item.id !== entry.id)), tone === "error" ? 7000 : 4000);
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/forge/scenarios/${encodeURIComponent(id)}`, { cache: "no-store" }).then(async (response) => {
      if (cancelled) return;
      if (response.status === 404) { setPhase("missing"); return; }
      const body = await response.json().catch(() => null);
      if (!response.ok || !body?.scenario) { setLoadError(body?.error ?? `HTTP ${response.status}`); setPhase("error"); return; }
      load(body.scenario); setMeta({ builtin: body.builtin, stored: body.stored, publishedVersion: body.publishedVersion ?? 0 }); setPhase("ready");
      // Deep links: /studio/<id>?step=<stepId> or ?part=<partId> (used by the Critic/admin views to jump to a problem).
      const search = new URLSearchParams(location.search);
      const deepStep = search.get("step"), deepPart = search.get("part");
      if (deepStep && body.scenario.steps.some((s: { id: string }) => s.id === deepStep)) setSelectedStepId(deepStep);
      else if (deepPart && body.scenario.parts.some((p: { id: string }) => p.id === deepPart)) setSelectedPartId(deepPart);
      if (search.get("view") === "exploded") setExploded(true);
    }).catch((error) => { if (!cancelled) { setLoadError(String(error)); setPhase("error"); } });
    return () => { cancelled = true; };
  }, [id, load]);

  const issues = useMemo(() => (doc ? validateScenario(doc) : []), [doc]);
  const mapped = useMemo(() => (doc ? mapIssues(doc, issues) : { steps: new Map(), parts: new Map(), targets: [] }), [doc, issues]);

  const save = useCallback(async (): Promise<ForgeScenario | null> => {
    if (!doc) return null;
    setBusy("save");
    const sent = fingerprint(doc);
    try {
      const response = await fetch(`/api/forge/scenarios/${encodeURIComponent(doc.id)}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(doc) });
      const body = await response.json().catch(() => null);
      if (!response.ok) { toast("error", `Save failed: ${body?.error ?? response.status}${body?.details ? ` — ${body.details.slice(0, 2).join("; ")}` : ""}`); return null; }
      markSaved(body.scenario, sent); setMeta((m) => ({ ...m, stored: true }));
      toast(body.issues?.length ? "warn" : "ok", `Draft v${body.scenario.version} saved${body.issues?.length ? ` · ${body.issues.length} issue${body.issues.length > 1 ? "s" : ""} to fix before publishing` : " · ready to publish"}`);
      return body.scenario as ForgeScenario;
    } catch (error) { toast("error", `Save failed: ${String(error)}`); return null; }
    finally { setBusy(""); }
  }, [doc, markSaved, toast]);

  const publish = useCallback(async (tokenOverride?: string) => {
    if (!doc) return;
    if (issues.length) { setTab("issues"); toast("warn", `Fix ${issues.length} issue${issues.length > 1 ? "s" : ""} before publishing.`); return; }
    const token = tokenOverride ?? sessionStorage.getItem(TOKEN_KEY) ?? "";
    setBusy("publish");
    const sent = fingerprint(doc);
    try {
      const response = await fetch(`/api/forge/scenarios/${encodeURIComponent(doc.id)}/publish`, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ scenario: doc }) });
      const body = await response.json().catch(() => null);
      if (response.status === 401) { sessionStorage.removeItem(TOKEN_KEY); setTokenPrompt({ message: token ? "That admin token was rejected." : "Publishing needs the admin token." }); return; }
      if (response.status === 503) { toast("error", body?.error ?? "Publishing is disabled on this server."); return; }
      if (!response.ok) { toast("error", `Publish failed: ${body?.error ?? response.status}${body?.issues ? ` — ${body.issues[0]}` : ""}`); return; }
      if (token) sessionStorage.setItem(TOKEN_KEY, token);
      markSaved(body.scenario, sent); setMeta((m) => ({ ...m, stored: true, publishedVersion: body.scenario.version })); setTokenPrompt(null);
      toast("ok", `Published v${body.scenario.version} · ${body.voiced ?? 0}/${body.steps ?? doc.steps.length} steps voiced`);
    } catch (error) { toast("error", `Publish failed: ${String(error)}`); }
    finally { setBusy(""); }
  }, [doc, issues.length, markSaved, toast]);

  const preview = useCallback(async () => {
    if (!doc) return;
    const tab = window.open("about:blank", "_blank");
    if (dirty && !(await save())) { tab?.close(); return; }
    const url = `/train/${encodeURIComponent(doc.id)}${doc.status === "draft" || dirty ? "?draft=1" : ""}`;
    if (tab) tab.location.href = url; else window.location.href = url;
  }, [dirty, doc, save]);

  // Keyboard: Ctrl+S save, Ctrl+Z / Ctrl+Shift+Z (Ctrl+Y) undo/redo outside text fields, Esc clears selection.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const typing = event.target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName);
      const mod = event.ctrlKey || event.metaKey;
      if (mod && event.key.toLowerCase() === "s") { event.preventDefault(); void save(); }
      else if (mod && !typing && event.key.toLowerCase() === "z") { event.preventDefault(); if (event.shiftKey) redo(); else undo(); }
      else if (mod && !typing && event.key.toLowerCase() === "y") { event.preventDefault(); redo(); }
      else if (event.key === "Escape" && !typing) { setSelectedStepId(null); setSelectedPartId(null); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [redo, save, undo]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  // 3D preview inputs, memoised on geometry so text edits never rebuild the scene.
  const step = doc?.steps.find((s) => s.id === selectedStepId) ?? null;
  const geometryKey = doc ? JSON.stringify([doc.parts, doc.baseParts]) : "";
  const sceneDoc = useSettled(useMemo(() => doc, [geometryKey]), geometryKey); // eslint-disable-line react-hooks/exhaustive-deps
  const before = doc && step && stepView ? installedBefore(doc, step.id) : null;
  const runKey = before ? `${step!.id}:${before.join(",")}` : "";
  const run = useMemo<RunState | null>(() => (before ? { completed: [], installed: before, activeStepId: step!.id, startedAt: 0, stepStartedAt: 0, mistakes: [] } : null), [runKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const highlightKey = step ? step.partIds.join(",") : selectedPartId ?? "";
  const highlight = useMemo(() => (highlightKey ? highlightKey.split(",") : []), [highlightKey]);
  const ghostKey = step && INSTALLING_KINDS.includes(step.kind) ? step.partIds.join(",") : selectedPartId && !step ? selectedPartId : "";
  const ghost = useMemo(() => (ghostKey ? ghostKey.split(",") : []), [ghostKey]);

  const selectStep = (stepId: string | null) => { setSelectedStepId(stepId); if (stepId) setSelectedPartId(null); };
  const selectPart = (partId: string | null) => { setSelectedPartId(partId); if (partId) setSelectedStepId(null); };

  if (phase === "loading") return <div className="fe-root fe-center"><div className="fe-spinner" /><p className="fe-sub">Loading scenario <code>{id}</code>…</p></div>;
  if (phase === "error") return <div className="fe-root fe-center"><h2>Could not load <code>{id}</code></h2><p className="fe-sub">{loadError}</p><button className="fe-btn" onClick={() => location.reload()}>Retry</button></div>;
  if (phase === "missing" || !doc) return <div className="fe-root fe-center">
    <div className="fe-missing">
      <span className="fe-eyebrow">Forge Studio</span>
      <h2>No scenario called <code>{id}</code> yet</h2>
      <p className="fe-sub">Start authoring it here. Nothing is stored until you save a draft.</p>
      <div className="fe-missing-actions">
        <button className="fe-card-btn" onClick={() => { load(blankScenario(id, titleFrom(id)), false); setPhase("ready"); }}><b>Blank assembly</b><span>A base plate and an empty procedure.</span></button>
        <button className="fe-card-btn" onClick={() => { load(demoScenario(id), false); setPhase("ready"); setSelectedStepId("s1"); }}><b>Leadscrew drive template</b><span>A NEMA 17 stepper drive in 9 steps: place, fasten, adjust, route and inspect. Good for a quick demo.</span></button>
      </div>
      <Link className="fe-link" href="/studio">← Back to studio</Link>
    </div>
  </div>;

  const voiced = doc.steps.filter((s) => s.audio?.url).length;
  return <div className="fe-root">
    <header className="fe-top">
      <Link href="/studio" className="fe-brand"><span className="fe-brand-mark">F</span><span>FORGE <b>STUDIO</b></span></Link>
      <div className="fe-top-title">
        <input className="fe-doc-title" value={doc.title} onChange={(event) => update((d) => ({ ...d, title: event.target.value }), "doc.title")} />
        <div className="fe-top-meta">
          <code>{doc.id}</code>
          <span className={`fe-status is-${doc.status}`}>{doc.status} v{doc.version}</span>
          {meta.publishedVersion > 0 && doc.status === "draft" && <span className="fe-mono-dim">live: v{meta.publishedVersion}</span>}
          {meta.builtin && <span className="fe-tag is-cyan" title="Edits fork this built-in into the database">built-in{meta.stored ? " · forked" : ""}</span>}
          {doc.source.approximation && <span className="fe-tag is-amber" title="Geometry or procedure is AI-estimated">approximation</span>}
          <span className="fe-mono-dim">{doc.parts.length} parts · {doc.steps.length} steps · {voiced} voiced</span>
          {dirty ? <span className="fe-dirty">● unsaved</span> : <span className="fe-saved">✓ saved</span>}
        </div>
      </div>
      <div className="fe-top-actions">
        <button className="fe-icon-btn is-lg" title="Undo (Ctrl+Z)" disabled={!canUndo} onClick={undo}>↶</button>
        <button className="fe-icon-btn is-lg" title="Redo (Ctrl+Shift+Z)" disabled={!canRedo} onClick={redo}>↷</button>
        <button className={`fe-icon-btn is-lg${voiceOn ? "" : " is-off"}`} title={voiceOn ? "Voice on" : "Voice muted"} onClick={() => { setVoiceEnabled(!voiceOn); setVoiceOn(!voiceOn); }}>{voiceOn ? "🔊" : "🔇"}</button>
        <span className="fe-divider" />
        <button className="fe-btn is-ghost" disabled={busy !== ""} onClick={() => void save()}>{busy === "save" ? "Saving…" : "Save draft"}</button>
        <button className="fe-btn is-ghost" onClick={() => void preview()}>Preview in trainer ↗</button>
        <button className="fe-btn is-amber" disabled={busy !== "" || issues.length > 0} title={issues.length ? `${issues.length} issue(s) block publishing` : "Publish a new version and voice every step"} onClick={() => void publish()}>{busy === "publish" ? "Publishing + voicing…" : `Publish v${Math.max(meta.publishedVersion + 1, doc.status === "draft" ? doc.version : 0)}`}</button>
      </div>
    </header>

    <main className="fe-main">
      <PartsPanel doc={doc} update={update} selectedPartId={selectedPartId} onSelect={selectPart} highlight={highlight} partIssues={mapped.parts} />

      <section className="fe-center-col">
        <div className="fe-stage">
          {sceneDoc && <ForgeScene scenario={sceneDoc} run={run} exploded={exploded} highlightPartIds={highlight} ghostPartIds={ghost} selectedPartId={selectedPartId} onPartSelect={(partId) => selectPart(partId)} className="fe-canvas" />}
          <div className="fe-stage-tools">
            <button className={`fe-seg${!exploded ? " is-on" : ""}`} onClick={() => setExploded(false)}>Assembled</button>
            <button className={`fe-seg${exploded ? " is-on" : ""}`} onClick={() => setExploded(true)}>Exploded</button>
            <span className="fe-divider" />
            <button className={`fe-seg${stepView ? " is-on" : ""}`} title="Show the assembly as it is before the selected step" onClick={() => setStepView(!stepView)}>Step state</button>
          </div>
          <div className="fe-stage-caption">
            {step ? <><span className="fe-kind" style={{ color: KIND_META[step.kind].color, borderColor: `${KIND_META[step.kind].color}66` }}>{KIND_META[step.kind].label}</span><b>Step {doc.steps.indexOf(step) + 1}</b> {step.title}<span className="fe-mono-dim">{step.partIds.map((pid) => doc.parts.find((p) => p.id === pid)?.name ?? pid).join(", ") || "no parts"}</span></>
              : selectedPartId ? <><span className="fe-kind">Part</span>{doc.parts.find((p) => p.id === selectedPartId)?.name}</>
                : <span className="fe-mono-dim">Select a step to preview it · ghost = target pose · drag to orbit</span>}
          </div>
          {issues.length > 0 && <button className="fe-stage-issues" onClick={() => setTab("issues")}>{issues.length} issue{issues.length > 1 ? "s" : ""} block publishing</button>}
        </div>

        <div className="fe-dock">
          <nav className="fe-tabs">
            <button className={tab === "issues" ? "is-on" : ""} onClick={() => setTab("issues")}>Issues <span className={`fe-count-pill${issues.length ? " is-bad" : " is-good"}`}>{issues.length || "✓"}</span></button>
            <button className={tab === "scenario" ? "is-on" : ""} onClick={() => setTab("scenario")}>Scenario</button>
            <button className={tab === "source" ? "is-on" : ""} onClick={() => setTab("source")}>Source {doc.source.approximation && <span className="fe-count-pill is-amber">≈</span>}</button>
          </nav>
          <div className="fe-dock-body">
            {tab === "issues" && <IssuesPanel targets={mapped.targets} onJump={(target) => { if (target.stepId) selectStep(target.stepId); else if (target.partId) selectPart(target.partId); }} />}
            {tab === "scenario" && <ScenarioPanel doc={doc} update={update} />}
            {tab === "source" && <SourcePanel doc={doc} update={update} />}
          </div>
        </div>
      </section>

      <StepsPanel doc={doc} update={update} selectedStepId={selectedStepId} onSelect={selectStep} stepIssues={mapped.steps} />
    </main>

    {tokenPrompt && <div className="fe-modal-back" onClick={() => setTokenPrompt(null)}>
      <form className="fe-modal" onClick={(event) => event.stopPropagation()} onSubmit={(event) => { event.preventDefault(); if (tokenDraft.trim()) void publish(tokenDraft.trim()); }}>
        <span className="fe-eyebrow">Admin required</span>
        <h3>Publish {doc.title}</h3>
        <p className="fe-sub">{tokenPrompt.message} It is kept in this tab&apos;s session storage only. Signed-in admins publish without a token.</p>
        <input className="fe-input is-mono" type="password" autoFocus placeholder="ADMIN_TOKEN" value={tokenDraft} onChange={(event) => setTokenDraft(event.target.value)} />
        <div className="fe-row-actions">
          <button type="button" className="fe-btn is-ghost" onClick={() => setTokenPrompt(null)}>Cancel</button>
          <button type="submit" className="fe-btn is-amber" disabled={!tokenDraft.trim() || busy !== ""}>{busy === "publish" ? "Publishing…" : "Publish"}</button>
        </div>
      </form>
    </div>}

    <div className="fe-toasts">{toasts.map((item) => <div key={item.id} className={`fe-toast is-${item.tone}`}>{item.text}</div>)}</div>
  </div>;
}

const titleFrom = (id: string) => id.split("-").filter(Boolean).map((word) => word[0].toUpperCase() + word.slice(1)).join(" ") || "Untitled assembly";
