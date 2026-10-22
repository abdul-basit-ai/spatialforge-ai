"use client";

import { useEffect, useMemo, useState } from "react";
import { fetchScenarioCards, type ScenarioCard } from "./data";

const SOURCE_LABEL: Record<string, string> = { upload: "Uploaded CAD / manual", web: "Open CAD from the web", generated: "Generated from knowledge", builtin: "Built-in" };

export function Gallery() {
  const [cards, setCards] = useState<ScenarioCard[] | null>(null);
  const [live, setLive] = useState(true);
  const [filter, setFilter] = useState<"all" | "mechanical" | "mechatronic">("all");
  const [query, setQuery] = useState("");
  useEffect(() => { void fetchScenarioCards().then((result) => { setCards(result.cards); setLive(result.live); }); }, []);
  const shown = useMemo(() => (cards ?? []).filter((card) => (filter === "all" || card.domain === filter) && (!query.trim() || `${card.title} ${card.summary}`.toLowerCase().includes(query.trim().toLowerCase()))), [cards, filter, query]);

  return (
    <div className="forge-app forge-gallery">
      <header className="forge-gallery-head">
        <div>
          <span className="forge-kicker">SpatialForge · Train</span>
          <h1>Pick an assembly. <em>Build it right.</em></h1>
          <p>Every scenario grows part by part through real mates: axis insertion, tolerance and keyed orientation, plus fasten, connect, route, adjust and inspect steps. Train in 3D, on a real table in AR, or with a ghost over real hardware.</p>
        </div>
        <div className="forge-gallery-tools">
          <div className="forge-modes" role="tablist">
            {(["all", "mechanical", "mechatronic"] as const).map((item) => <button key={item} type="button" className={filter === item ? "is-active" : ""} onClick={() => setFilter(item)}>{item === "all" ? "All" : item[0].toUpperCase() + item.slice(1)}</button>)}
          </div>
          <input className="forge-search" placeholder="Search scenarios" value={query} onChange={(event) => setQuery(event.target.value)} />
        </div>
      </header>
      {!live && cards && <p className="forge-note forge-offline">Scenario library offline: showing built-in scenarios.</p>}
      {!cards ? (
        <div className="forge-grid">{[0, 1, 2].map((i) => <div key={i} className="forge-card is-skeleton" />)}</div>
      ) : (
        <div className="forge-grid">
          {shown.map((card) => (
            <a key={card.id} className={`forge-card is-${card.domain}`} href={`/train/${card.id}`}>
              <div className="forge-card-art" aria-hidden><span className="forge-card-glyph">{card.domain === "mechatronic" ? "⌁" : "⚙"}</span><span className="forge-card-grid" /></div>
              <div className="forge-card-body">
                <div className="forge-card-tags">
                  <span className={`forge-tag is-${card.domain}`}>{card.domain}</span>
                  {card.status === "draft" && <span className="forge-tag is-draft">draft</span>}
                  {card.approximation && <span className="forge-tag is-approx">AI-estimated</span>}
                  <span className="forge-tag">v{card.version}</span>
                </div>
                <h2>{card.title}</h2>
                <p>{card.summary || "No summary yet."}</p>
                <dl className="forge-card-stats">
                  <div><dt>Parts</dt><dd>{card.parts}</dd></div>
                  <div><dt>Steps</dt><dd>{card.steps}</dd></div>
                  <div><dt>Source</dt><dd>{SOURCE_LABEL[card.source] ?? card.source}</dd></div>
                </dl>
                <span className="forge-card-cta">Start training →</span>
              </div>
            </a>
          ))}
          <a className="forge-card is-new" href="/studio">
            <div className="forge-card-body">
              <span className="forge-kicker">Studio</span>
              <h2>Build a new scenario</h2>
              <p>Upload STEP, IGES, STL, OBJ or glTF, a PDF manual or photos, or just describe it: “train me to assemble a planetary gearbox”.</p>
              <span className="forge-card-cta">Open Studio →</span>
            </div>
          </a>
          {!shown.length && <p className="forge-note">No scenarios match.</p>}
        </div>
      )}
    </div>
  );
}
