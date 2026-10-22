"use client";

import { useCallback, useEffect, useState } from "react";
import { partFor, type PartId, type ScenarioId } from "@/lib/assembly";
import { GUIDANCE_FIELDS, type Guidance, type StepGuidance } from "@/lib/guidance";

type Proposal = { id: string; based_on_version: string; step_id: string; kind: string; source: "llm" | "rules"; model: string | null; rationale: string; status: "pending" | "approved" | "rejected"; created_at: string; reviewed_at: string | null; approved_version: string | null; guidance: Guidance; evidence: { pattern?: { runsWithError: number; totalRuns: number; rate: number; operators: number; totalOperators: number; corrections: number; dagVersion: string }; wrongOrder?: { attemptedPartId: string; requiredPartId: string; runs: number } | null; hesitation?: { medianMs: number; samples: number } | null; toolsCalled?: string[]; threshold?: { minRate: number; minRuns: number } } };
type Impact = { steps: Array<{ id: string; short: string }>; versions: Array<{ version: string; active: boolean; runs: number; steps: Array<{ stepId: string; runsWithError: number; rate: number }> }>; persisted: boolean };
type CriticResult = { ok: boolean; error?: string; operator: string; source: string; version: string; llmError?: string; proposal: { stepId: string; kind: string; source: string } | null; proposalSkipped?: string; candidates: unknown[]; profile: { updated: boolean; summary: string } };

const TOKEN_KEY = "spatialforge:admin-token";
// Categorical slots (dark surface), assigned to versions in a fixed order; validated for CVD separation.
const SERIES = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"];
const KIND_LABEL: Record<string, string> = { out_of_sequence_pick: "out-of-order pick", "wrong-target": "wrong target", orientation: "wrong rotation", prerequisite: "prerequisite skipped" };
const FIELD_LABEL: Record<string, string> = { preWarning: "Pre-warning", hint: "Hint", voiceLine: "Voice line", substeps: "Substeps" };
const show = (value: StepGuidance[keyof StepGuidance]) => Array.isArray(value) ? value.join(" → ") : value || "";
const pct = (value: number) => `${Math.round(value * 100)}%`;

export function AgentReview({ scenario, operator }: { scenario: ScenarioId; operator: string }) {
  const [token, setToken] = useState("");
  const [tokenDraft, setTokenDraft] = useState("");
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [active, setActive] = useState<{ version: string; guidance: Guidance } | null>(null);
  const [persisted, setPersisted] = useState(true);
  const [impact, setImpact] = useState<Impact | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [showTable, setShowTable] = useState(false);

  useEffect(() => { const saved = sessionStorage.getItem(TOKEN_KEY) || ""; setToken(saved); setTokenDraft(saved); }, []);
  const load = useCallback(async () => {
    const [list, chart] = await Promise.all([
      fetch(`/api/agent/proposals?scenario=${scenario}`).then((response) => response.ok ? response.json() : null).catch(() => null),
      fetch(`/api/analytics/version-impact?scenario=${scenario}`).then((response) => response.ok ? response.json() : null).catch(() => null),
    ]);
    setProposals(list?.proposals || []); setActive(list?.active || null); setPersisted(Boolean(list?.persisted)); setImpact(chart);
  }, [scenario]);
  useEffect(() => { void load(); }, [load]);

  const call = async (path: string, body: unknown) => {
    const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json", "x-admin-token": token }, body: JSON.stringify(body) });
    const json = await response.json().catch(() => ({}));
    if (response.status === 401) throw new Error("Admin token rejected. Enter the ADMIN_TOKEN configured on the server.");
    if (!response.ok && !json.results) throw new Error(json.error || `Request failed (${response.status})`);
    return json;
  };
  const describe = (result: CriticResult) => result.error && !result.ok ? `Critic failed: ${result.error}` : `${result.operator ? `Operator ${result.operator}` : "All operators"} on v${result.version}: ${result.proposal ? `new ${result.source === "llm" ? "LLM" : "rule-based"} proposal for ${partFor(scenario, result.proposal.stepId as PartId)?.short ?? result.proposal.stepId} (${KIND_LABEL[result.proposal.kind] ?? result.proposal.kind})` : result.proposalSkipped ? `no new proposal (${result.proposalSkipped})` : result.candidates.length ? "pattern found but not stored" : "no pattern passed the threshold"}. Profile ${result.profile.updated ? "updated" : "unchanged"}.${result.llmError ? ` LLM unavailable, rules used (${result.llmError}).` : ""}`;
  const runCritic = async () => {
    setBusy("critic"); setNotice("Critic is reading ClickHouse…");
    try {
      let json = await call("/api/agent/critic", { max: 10 });
      if (!json.results?.length) json = await call("/api/agent/critic", { scenario, operator });
      setNotice((json.results as CriticResult[]).map(describe).join(" ") || "Nothing to analyse yet.");
      await load();
    } catch (error) { setNotice(error instanceof Error ? error.message : "Critic failed"); }
    finally { setBusy(null); }
  };
  const review = async (proposal: Proposal, action: "approve" | "reject") => {
    setBusy(proposal.id);
    try {
      const json = await call(`/api/agent/proposals/${proposal.id}`, { action });
      setNotice(action === "approve" ? `Approved. Instructions v${json.version} are now active for ${scenario}; Coach caches cleared.` : "Proposal rejected.");
      await load();
    } catch (error) { setNotice(error instanceof Error ? error.message : "Review failed"); }
    finally { setBusy(null); }
  };
  const saveToken = () => { sessionStorage.setItem(TOKEN_KEY, tokenDraft.trim()); setToken(tokenDraft.trim()); setNotice(tokenDraft.trim() ? "Admin token saved for this browser tab." : "Admin token cleared."); };
  const versions = (impact?.versions || []).slice(-SERIES.length);
  const color = (version: string) => SERIES[Math.max(0, versions.findIndex((item) => item.version === version))];

  return <>
    <section className="admin-activity information-card agent-panel">
      <div className="admin-section-heading"><div><div className="card-kicker">AGENT LOOP</div><h2>Critic and instruction versions</h2></div><span>{active ? `ACTIVE v${active.version}` : "LOCAL MODE"}</span></div>
      <div className="agent-toolbar">
        <label className="token-field">Admin token<input type="password" autoComplete="off" value={tokenDraft} onChange={(event) => setTokenDraft(event.target.value)} placeholder="ADMIN_TOKEN" /></label>
        <button type="button" onClick={saveToken}>{token ? "Update token" : "Save token"}</button>
        <button type="button" className="primary" disabled={busy !== null || !token} onClick={runCritic}>{busy === "critic" ? "Running critic…" : "Run critic"}</button>
      </div>
      <p className="agent-notice" role="status">{notice || (persisted ? "The Critic processes queued completed runs, or analyses this scenario when the queue is empty." : "PostgreSQL is not configured, so proposals are unavailable. Training still works locally.")}</p>
    </section>

    <section className="admin-activity information-card agent-panel">
      <div className="admin-section-heading"><div><div className="card-kicker">PROPOSALS</div><h2>{proposals.filter((item) => item.status === "pending").length} awaiting review</h2></div><span>NOTHING GOES LIVE WITHOUT APPROVAL</span></div>
      {proposals.length ? <div className="proposal-list">{proposals.map((proposal) => {
        const part = partFor(scenario, proposal.step_id as PartId);
        const proposed = proposal.guidance.steps[proposal.step_id as PartId] || {};
        const current = active?.guidance.steps[proposal.step_id as PartId] || {};
        const evidence = proposal.evidence.pattern;
        return <article key={proposal.id} className={`proposal is-${proposal.status}`}>
          <header><strong>{part?.short ?? proposal.step_id} · {KIND_LABEL[proposal.kind] ?? proposal.kind}</strong><span className={`source-badge is-${proposal.source}`}>{proposal.source === "llm" ? "LLM" : "RULES"}</span><span className="proposal-status">{proposal.status === "approved" ? `APPROVED → v${proposal.approved_version}` : proposal.status.toUpperCase()} · based on v{proposal.based_on_version}</span></header>
          {evidence && <div className="evidence-row"><span><b>{evidence.runsWithError}/{evidence.totalRuns}</b> runs ({pct(evidence.rate)})</span><span><b>{evidence.operators}/{evidence.totalOperators}</b> operators</span><span><b>{evidence.corrections}</b> corrections</span>{proposal.evidence.wrongOrder && <span>picked <b>{partFor(scenario, proposal.evidence.wrongOrder.attemptedPartId as PartId)?.short}</b> before <b>{partFor(scenario, proposal.evidence.wrongOrder.requiredPartId as PartId)?.short}</b></span>}{proposal.evidence.hesitation && <span>median <b>{(proposal.evidence.hesitation.medianMs / 1000).toFixed(1)}s</b> grab→place</span>}</div>}
          <p className="proposal-rationale">{proposal.rationale}</p>
          <table className="guidance-diff"><thead><tr><th scope="col">Field</th><th scope="col">Current (v{active?.version ?? proposal.based_on_version})</th><th scope="col">Proposed</th></tr></thead><tbody>{GUIDANCE_FIELDS.filter((field) => proposed[field] !== undefined).map((field) => <tr key={field}><th scope="row">{FIELD_LABEL[field]}</th><td className="diff-old">{show(current[field]) || <i>built-in text</i>}</td><td className="diff-new">{show(proposed[field])}</td></tr>)}</tbody></table>
          {proposal.status === "pending" && <div className="proposal-actions"><button type="button" className="primary" disabled={busy !== null || !token} onClick={() => review(proposal, "approve")}>{busy === proposal.id ? "Saving…" : "Approve"}</button><button type="button" disabled={busy !== null || !token} onClick={() => review(proposal, "reject")}>Reject</button>{!token && <small>Enter the admin token to review.</small>}</div>}
          <small className="proposal-meta">Tools: {proposal.evidence.toolsCalled?.join(", ") || "n/a"}{proposal.model ? ` · ${proposal.model}` : ""} · {new Date(proposal.created_at).toLocaleString()}</small>
        </article>;
      })}</div> : <p className="empty-activity">No proposals yet. Seed data or complete runs, then run the critic.</p>}
    </section>

    <section className="admin-activity information-card agent-panel">
      <div className="admin-section-heading"><div><div className="card-kicker">VERSION IMPACT</div><h2>Error rate per step by instruction version</h2></div><button type="button" className="table-toggle" onClick={() => setShowTable((value) => !value)}>{showTable ? "Show chart" : "Show table"}</button></div>
      {versions.length ? <>
        <div className="impact-legend">{versions.map((item) => <span key={item.version}><i style={{ background: color(item.version) }} />v{item.version}{item.active ? " (active)" : ""} · {item.runs} runs</span>)}</div>
        {showTable ? <table className="impact-table"><thead><tr><th scope="col">Step</th>{versions.map((item) => <th scope="col" key={item.version}>v{item.version}</th>)}</tr></thead><tbody>{impact!.steps.map((step) => <tr key={step.id}><th scope="row">{step.id} {step.short}</th>{versions.map((item) => { const stat = item.steps.find((entry) => entry.stepId === step.id); return <td key={item.version}>{item.runs ? `${pct(stat?.rate ?? 0)} (${stat?.runsWithError ?? 0}/${item.runs})` : "no runs"}</td>; })}</tr>)}</tbody></table>
        : <div className="impact-chart" role="img" aria-label={`Share of runs with a correction at each ${scenario} step, per instruction version`}>{impact!.steps.map((step) => <div className="impact-step" key={step.id}><div className="impact-label">{step.id}<span>{step.short}</span></div><div className="impact-bars">{versions.map((item) => { const stat = item.steps.find((entry) => entry.stepId === step.id); const rate = stat?.rate ?? 0; return <div className="impact-bar-row" key={item.version} title={`v${item.version} · ${step.short}: ${item.runs ? `${pct(rate)} of ${item.runs} runs (${stat?.runsWithError ?? 0})` : "no runs yet"}`}><span className="impact-track"><i style={{ width: `${Math.max(rate * 100, item.runs ? 0.6 : 0)}%`, background: color(item.version) }} /></span><span className="impact-value">{item.runs ? pct(rate) : "–"}</span></div>; })}</div></div>)}<div className="impact-axis"><span>0%</span><span>50%</span><span>100%</span></div></div>}
      </> : <p className="empty-activity">{impact?.persisted === false ? "ClickHouse is not configured, so version impact is unavailable." : "No completed runs recorded yet."}</p>}
    </section>
  </>;
}
