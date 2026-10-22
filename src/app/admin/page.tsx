"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { getScenario, partFor, SCENARIO_IDS } from "@/lib/assembly";
import { useAssemblyStore } from "@/lib/store";
import type { SpatialEvent } from "@/lib/spatial-engine";

export default function Admin() {
  const { operator, scenario, placements, errors, passport, hydrate, setScenario } = useAssemblyStore();
  const [telemetry, setTelemetry] = useState<SpatialEvent[]>([]);
  const [replayIndex, setReplayIndex] = useState(0);
  const [sessions, setSessions] = useState<Array<{ id: string; scenario_id: string; mode: string; started_at: string }>>([]);
  useEffect(() => { hydrate(); }, [hydrate]);
  useEffect(() => {
    try { setTelemetry(JSON.parse(localStorage.getItem("spatialforge:telemetry:v1") || "[]") as SpatialEvent[]); } catch { setTelemetry([]); }
    fetch("/api/sessions").then((response) => response.ok ? response.json() : null).then((body) => setSessions(body?.sessions || [])).catch(() => undefined);
  }, []);
  const definition = getScenario(scenario);
  const activity = [
    ...placements.map((item) => ({ at: item.at, title: `${partFor(scenario, item.partId)?.short || item.partId} placed`, detail: `${item.targetId} · ${item.method} · ${item.rotation}°`, kind: "success" })),
    ...errors.map((item) => ({ at: item.at, title: `${item.kind.replace("-", " ")} correction`, detail: `${item.partId}${item.attemptedTarget ? ` · ${item.attemptedTarget} attempted` : ""}${item.prerequisite ? ` · after ${item.prerequisite}` : ""}`, kind: "warning" })),
  ].sort((a, b) => b.at.localeCompare(a.at));

  return <div className="app-shell">
    <header className="topbar"><Link href="/" className="brand"><span className="brand-mark">◇</span><span>SPATIAL<span className="brand-accent">FORGE</span></span><span className="brand-ai">AI</span></Link><Link className="admin-link" href="/">← Back to assembly</Link></header>
    <main className="main admin-main">
      <div className="eyebrow"><span className="eyebrow-line" /> RUN REVIEW / OPERATOR {operator}</div>
      <h1>Assembly activity</h1>
      <p className="lede">Review the selected scenario. Placement, prerequisite, target, orientation, and tracking corrections are recorded locally for this operator.</p>
      <div className="scenario-tabs admin-scenario-tabs">{SCENARIO_IDS.map((id) => <button type="button" key={id} className={scenario === id ? "selected" : ""} onClick={() => setScenario(id)}>{getScenario(id).name}<small>{id === scenario ? "Selected" : "View run"}</small></button>)}</div>
      <div className="admin-stats">
        <div className="information-card"><div className="card-kicker">PLACED</div><strong>{placements.length}<span> / {definition.parts.length}</span></strong><p>Parts in this {definition.name.toLowerCase()} run</p></div>
        <div className="information-card"><div className="card-kicker">CORRECTIONS</div><strong>{errors.length}</strong><p>Target, orientation, prerequisite, or tracking events</p></div>
        <div className="information-card"><div className="card-kicker">RUN RECORD</div><strong>{passport ? "Ready" : "Open"}</strong><p>{passport ? "Demo SHA-256 hash created" : `Complete ${definition.parts.length} placements for a hash`}</p></div>
        <div className="information-card"><div className="card-kicker">TELEMETRY</div><strong>{telemetry.length}</strong><p>Queued semantic events on this device</p></div>
      </div>
      <section className="admin-activity information-card"><div className="admin-section-heading"><div><div className="card-kicker">SESSION REPLAY</div><h2>{telemetry.length ? `Event ${Math.min(replayIndex + 1, telemetry.length)} of ${telemetry.length}` : "No queued events"}</h2></div><div><button type="button" onClick={() => setReplayIndex((value) => Math.max(0, value - 1))}>←</button><button type="button" onClick={() => setReplayIndex((value) => Math.min(Math.max(telemetry.length - 1, 0), value + 1))}>→</button></div></div>{telemetry.length ? <div className="activity-row"><span className="activity-indicator success" /><div><strong>{telemetry[replayIndex]?.type}</strong><small>{telemetry[replayIndex]?.mode} · {telemetry[replayIndex]?.source || "system"} · sequence {telemetry[replayIndex]?.sequence}</small></div><time>{new Date(telemetry[replayIndex]?.at).toLocaleString()}</time></div> : <p className="empty-activity">Start a run to create replayable events.</p>}</section>
      <section className="admin-activity information-card"><div className="admin-section-heading"><div><div className="card-kicker">CLOUD SESSIONS</div><h2>{sessions.length} recorded sessions</h2></div><span>POSTGRESQL WHEN CONFIGURED</span></div>{sessions.length ? <div className="activity-list">{sessions.slice(0, 10).map((session) => <div className="activity-row" key={session.id}><span className="activity-indicator success" /><div><strong>{session.scenario_id} · {session.mode}</strong><small>{session.id}</small></div><time>{new Date(session.started_at).toLocaleString()}</time></div>)}</div> : <p className="empty-activity">Cloud session persistence is unavailable or has no sessions yet.</p>}</section>
      <section className="admin-activity information-card"><div className="admin-section-heading"><div><div className="card-kicker">EVENT LOG</div><h2>Latest activity</h2></div><span>LOCAL BROWSER DATA</span></div>{activity.length ? <div className="activity-list">{activity.map((item, index) => <div className="activity-row" key={`${item.at}-${index}`}><span className={`activity-indicator ${item.kind}`} /><div><strong>{item.title}</strong><small>{item.detail}</small></div><time dateTime={item.at}>{new Date(item.at).toLocaleString()}</time></div>)}</div> : <p className="empty-activity">No activity yet. Start a run to see placement and correction events here.</p>}</section>
      {passport && <div className="information-card admin-passport"><div className="card-kicker">DEMO PASSPORT</div><code className="hash">SHA-256 · {passport}</code></div>}
    </main>
  </div>;
}
