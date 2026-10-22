"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ForgeProposalReview } from "@/components/AgentReview";
import { StruggleChart, VersionBars, type ChartStep } from "./StruggleChart";
import "../signin/people.css";

// Forge sections of /admin: who trains (people), where the group struggles (analytics per scenario and version),
// what one operator remembers (long-term profile + short-term state), and Critic proposals for the scenario.
const TOKEN_KEY = "spatialforge:admin-token";
type Me = { id: string; name: string; role: string } | null;
type ScenarioItem = { id: string; title: string; version: number | null; status: string | null; runs: number; operators: number; lastEventAt: string | null };
type Analytics = { scenarioId: string; title: string; currentVersion: number | null; version: string | null; source: string; totals: { runs: number; sessions: number; operators: number; mistakes: number }; steps: Array<ChartStep & { order: number; hints: number; completions: number }>; topStruggling: Array<{ stepId: string; title: string; mistakeRate: number }>; versions: Array<{ version: string; runs: number; sessions: number; operators: number; steps: Array<{ stepId: string; mistakeRate: number; attempts: number; sessionsWithMistake: number; medianMs: number }> }> };
type Person = { id: string; name: string; role: string; registered: boolean; lastSeenAt: string | null; runs: number; scenarios: number; mistakes: number };
type Profile = { scenarioId: string; runs: number; lastSeen: string; lastVersion: number; lastMode: string; totalMistakes: number; mistakes: Record<string, Record<string, number>>; avgStepMs: Record<string, number>; lastRun: { mistakeCount: number; totalMs: number; at: string } | null };
type ShortTerm = { scenarioId: string; version: number; sessionId: string; mode: string; currentStepId: string | null; timeOnStepMs: number; hesitating: boolean; mistakes: Record<string, Record<string, number>>; mistakeCount: number; stepsCompleted: string[]; completed: boolean; lastEvents: Array<{ type: string; stepId?: string; reason?: string; at: string }>; updatedAt: string };
type Drill = { operator: { id: string; name: string; role: string; lastSeenAt?: string | null }; profiles: Profile[]; shortTerm: ShortTerm[] };

const ago = (iso: string | null | undefined) => {
  if (!iso) return "never";
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`;
};
const sec = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
const pct = (value: number) => `${Math.round(value * 100)}%`;

export function ForgePeople() {
  const [me, setMe] = useState<Me>(null);
  const [token, setToken] = useState("");
  const [tokenDraft, setTokenDraft] = useState("");
  const [scenarios, setScenarios] = useState<ScenarioItem[]>([]);
  const [scenarioId, setScenarioId] = useState("");
  const [version, setVersion] = useState("");
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [people, setPeople] = useState<Person[] | null>(null);
  const [peopleError, setPeopleError] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [drill, setDrill] = useState<Drill | null>(null);
  const [table, setTable] = useState(false);

  const headers = useCallback((): HeadersInit => token ? { "x-admin-token": token } : {}, [token]);
  useEffect(() => {
    const saved = sessionStorage.getItem(TOKEN_KEY) || ""; setToken(saved); setTokenDraft(saved);
    fetch("/api/auth/me").then((r) => r.ok ? r.json() : null).then((body) => setMe(body?.operator ?? null)).catch(() => undefined);
    fetch("/api/forge/analytics").then((r) => r.ok ? r.json() : null).then((body) => {
      const list: ScenarioItem[] = body?.scenarios ?? [];
      setScenarios(list);
      const linked = new URLSearchParams(window.location.search).get("forge");
      setScenarioId((current) => current || (linked && list.some((item) => item.id === linked) ? linked : list[0]?.id) || "");
    }).catch(() => undefined);
  }, []);
  const isAdmin = me?.role === "admin" || Boolean(token);

  const loadAnalytics = useCallback(async () => {
    if (!scenarioId) return;
    const body = await fetch(`/api/forge/analytics?scenarioId=${encodeURIComponent(scenarioId)}${version ? `&version=${version}` : ""}`).then((r) => r.ok ? r.json() : null).catch(() => null);
    setAnalytics(body);
  }, [scenarioId, version]);
  useEffect(() => { void loadAnalytics(); }, [loadAnalytics]);

  const loadPeople = useCallback(async () => {
    const response = await fetch("/api/forge/analytics/people", { headers: headers() }).catch(() => null);
    if (!response?.ok) { setPeople(null); setPeopleError(response?.status === 401 ? "Sign in as an admin operator or enter the admin token to see people." : "People are unavailable right now."); return; }
    setPeople((await response.json()).people); setPeopleError("");
  }, [headers]);
  useEffect(() => { void loadPeople(); }, [loadPeople, me]);

  useEffect(() => {
    if (!selected) { setDrill(null); return; }
    fetch(`/api/forge/analytics/operator?operatorId=${encodeURIComponent(selected)}`, { headers: headers() }).then((r) => r.ok ? r.json() : null).then(setDrill).catch(() => setDrill(null));
  }, [selected, headers]);

  const saveToken = () => { sessionStorage.setItem(TOKEN_KEY, tokenDraft.trim()); setToken(tokenDraft.trim()); };
  const stepTitle = (id: string) => analytics?.steps.find((step) => step.stepId === id)?.title ?? id;
  const top = analytics?.topStruggling.map((step) => step.stepId) ?? [];

  return <div className="pf-root pf-admin">
    <div className="pf-bar">
      <span className="pf-kicker">FORGE</span>
      {me ? <span className={`pf-chip ${me.role === "admin" ? "warn" : "on"}`}>{me.name} · {me.role.toUpperCase()}</span> : <span className="pf-chip">SIGNED OUT</span>}
      {!me && <Link href="/signin?next=/admin">Sign in →</Link>}
      {me && <button type="button" className="pf-small-btn" onClick={async () => { await fetch("/api/auth/signout", { method: "POST" }); setMe(null); setPeople(null); }}>Sign out</button>}
      <span style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
        <input className="pf-token" type="password" autoComplete="off" placeholder="ADMIN_TOKEN (optional)" value={tokenDraft} onChange={(event) => setTokenDraft(event.target.value)} aria-label="Admin token" />
        <button type="button" className="pf-small-btn" onClick={saveToken}>{token ? "Update" : "Use token"}</button>
      </span>
    </div>

    <section className="pf-panel">
      <div className="pf-head"><div><div className="pf-kicker">GROUP STRUGGLE · CLICKHOUSE</div><h2>{analytics ? `${analytics.title}${analytics.version ? ` · v${analytics.version}` : ""}` : "Forge analytics"}</h2></div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <select className="pf-select" value={scenarioId} onChange={(event) => { setScenarioId(event.target.value); setVersion(""); }} aria-label="Scenario">{scenarios.length ? scenarios.map((item) => <option key={item.id} value={item.id}>{item.title} · {item.runs} runs</option>) : <option value="">No Forge scenarios yet</option>}</select>
          {analytics && analytics.versions.length > 1 && <select className="pf-select" value={version || analytics.version || ""} onChange={(event) => setVersion(event.target.value)} aria-label="Version">{analytics.versions.map((v) => <option key={v.version} value={v.version}>v{v.version} · {v.runs} runs</option>)}</select>}
          <button type="button" className="pf-small-btn" onClick={() => setTable((value) => !value)}>{table ? "Chart" : "Table"}</button>
          <button type="button" className="pf-small-btn" onClick={() => void loadAnalytics()}>Refresh</button>
        </div></div>
      {analytics ? <>
        <div className="pf-stats">
          <div className="pf-stat"><span>RUNS COMPLETED</span><strong>{analytics.totals.runs}<small>/ {analytics.totals.sessions} sessions</small></strong></div>
          <div className="pf-stat"><span>OPERATORS</span><strong>{analytics.totals.operators}</strong></div>
          <div className="pf-stat"><span>MISTAKES</span><strong>{analytics.totals.mistakes}</strong></div>
          <div className="pf-stat"><span>TOP STRUGGLE</span><strong style={{ fontSize: 15, marginTop: 9 }}>{analytics.topStruggling[0] ? `${analytics.topStruggling[0].title} · ${pct(analytics.topStruggling[0].mistakeRate)}` : "—"}</strong></div>
        </div>
        <div className="pf-meta" style={{ font: "10px 'DM Mono',monospace", color: "var(--pf-muted)", marginBottom: 6 }}>SHARE OF SESSIONS WITH A MISTAKE AT EACH STEP · SOURCE {analytics.source.toUpperCase()}</div>
        {table ? <table className="pf-table"><thead><tr><th>Step</th><th className="num">Attempts</th><th className="num">Mistake rate</th><th>By reason</th><th className="num">Median</th><th className="num">Hints</th></tr></thead><tbody>{analytics.steps.map((step) => <tr key={step.stepId}><td>{step.title}</td><td className="num">{step.attempts}</td><td className="num">{pct(step.mistakeRate)}</td><td>{Object.entries(step.byReason).map(([reason, count]) => <span key={reason} className="pf-pill amber">{reason} {count}</span>)}</td><td className="num">{step.medianMs ? sec(step.medianMs) : "—"}</td><td className="num">{step.hints}</td></tr>)}</tbody></table>
          : analytics.steps.length ? <StruggleChart steps={analytics.steps} highlight={top} /> : <p className="pf-empty">No step data yet.</p>}
        {analytics.versions.length > 1 && <div style={{ marginTop: 18 }}><div className="pf-kicker">VERSION COMPARISON</div><VersionBars steps={analytics.steps} versions={analytics.versions} /></div>}
      </> : <p className="pf-empty">{scenarios.length ? "Loading analytics…" : "No Forge runs recorded yet. Train a scenario to see struggle analytics."}</p>}
    </section>

    <section className="pf-panel">
      <div className="pf-head"><div><div className="pf-kicker">PEOPLE · POSTGRESQL</div><h2>{people ? `${people.length} operators` : "Operators"}</h2></div><button type="button" className="pf-small-btn" onClick={() => void loadPeople()}>Refresh</button></div>
      {people ? people.length ? <table className="pf-table"><thead><tr><th>Operator</th><th>Role</th><th className="num">Runs</th><th className="num">Scenarios</th><th className="num">Mistakes</th><th className="num">Last seen</th></tr></thead><tbody>
        {people.map((person) => <tr key={person.id} className={`pf-click ${selected === person.id ? "sel" : ""}`} onClick={() => setSelected(selected === person.id ? null : person.id)}>
          <td><div className="pf-name"><i>{person.name.slice(0, 1).toUpperCase()}</i><div>{person.name}<small>{person.id}</small></div></div></td>
          <td><span className={`pf-pill ${person.role === "admin" ? "amber" : person.registered ? "cyan" : "red"}`}>{person.role}</span></td>
          <td className="num">{person.runs}</td><td className="num">{person.scenarios}</td><td className="num">{person.mistakes}</td><td className="num">{ago(person.lastSeenAt)}</td>
        </tr>)}
      </tbody></table> : <p className="pf-empty">Nobody has signed in yet.</p> : <p className="pf-empty">{peopleError || "Loading…"}</p>}
      {drill && <div style={{ marginTop: 16 }}>
        <div className="pf-head"><div><div className="pf-kicker">OPERATOR DRILL-DOWN</div><h2>{drill.operator.name}</h2></div><span className="pf-meta">{drill.operator.id}</span></div>
        <div className="pf-grid2">
          <div className="pf-box"><h3>Long-term memory</h3>{drill.profiles.length ? drill.profiles.map((profile) => <div key={profile.scenarioId} style={{ marginBottom: 12 }}>
            <dl className="pf-kv"><dt>Scenario</dt><dd>{profile.scenarioId} · v{profile.lastVersion}</dd><dt>Runs</dt><dd>{profile.runs}</dd><dt>Mistakes</dt><dd>{profile.totalMistakes}</dd><dt>Last seen</dt><dd>{ago(profile.lastSeen)} · {profile.lastMode}</dd>{profile.lastRun && <><dt>Last run</dt><dd>{profile.lastRun.mistakeCount} mistakes · {sec(profile.lastRun.totalMs)}</dd></>}</dl>
            <div style={{ marginTop: 8 }}>{Object.entries(profile.mistakes).flatMap(([step, reasons]) => Object.entries(reasons).map(([reason, count]) => <span key={`${step}-${reason}`} className="pf-pill amber">{profile.scenarioId === scenarioId ? stepTitle(step) : step} · {reason} ×{count}</span>))}</div>
            <div style={{ marginTop: 4 }}>{Object.entries(profile.avgStepMs).map(([step, ms]) => <span key={step} className="pf-pill cyan">{profile.scenarioId === scenarioId ? stepTitle(step) : step} {sec(ms)}</span>)}</div>
          </div>) : <p className="pf-empty">No completed runs yet.</p>}</div>
          <div className="pf-box"><h3>Short-term memory · Valkey 24 h</h3>{drill.shortTerm.length ? drill.shortTerm.map((stm) => <div key={stm.scenarioId} style={{ marginBottom: 12 }}>
            <dl className="pf-kv"><dt>Scenario</dt><dd>{stm.scenarioId} · v{stm.version} · {stm.mode}</dd><dt>State</dt><dd>{stm.completed ? <span className="pf-pill green">completed</span> : <span className="pf-pill cyan">in progress</span>}{stm.hesitating && <span className="pf-pill red">hesitating</span>}</dd><dt>Current step</dt><dd>{stm.currentStepId ? `${stm.scenarioId === scenarioId ? stepTitle(stm.currentStepId) : stm.currentStepId} · ${sec(stm.timeOnStepMs)}` : "—"}</dd><dt>Session mistakes</dt><dd>{stm.mistakeCount}</dd><dt>Steps done</dt><dd>{stm.stepsCompleted.length}</dd></dl>
            <div className="pf-events" style={{ marginTop: 8 }}>{[...stm.lastEvents].reverse().map((event, index) => <div key={index}><time>{new Date(event.at).toLocaleTimeString()}</time><span>{event.type.replace("forge_", "")}{event.stepId ? ` · ${event.stepId}` : ""}</span><span>{event.reason ?? ""}</span></div>)}</div>
          </div>) : <p className="pf-empty">No live session in the last 24 hours.</p>}</div>
        </div>
      </div>}
    </section>

    {scenarioId && <ForgeProposalReview scenarioId={scenarioId} adminToken={token} canReview={isAdmin} onChange={() => void loadAnalytics()} />}
  </div>;
}
