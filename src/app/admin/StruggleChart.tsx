"use client";

// Plain-SVG horizontal bars: share of sessions with a mistake at each step (one series, so no legend box; the title names it).
// Hover a row for the full numbers; the whole row is the hit target. A table view is offered by the caller.
export type ChartStep = { stepId: string; title: string; attempts: number; sessionsWithMistake: number; mistakeRate: number; medianMs: number; mistakes: number; byReason: Record<string, number | undefined> };
const AMBER = "#ffb547", TRACK = "#141d24", GRID = "#22303a", INK = "#e8eef2", MUTED = "#8a9aa6";
const pct = (value: number) => `${Math.round(value * 100)}%`;

export function StruggleChart({ steps, highlight = [], threshold = 0.3 }: { steps: ChartStep[]; highlight?: string[]; threshold?: number }) {
  const row = 30, labelW = 210, valueW = 120, width = 760, top = 8, plotW = width - labelW - valueW;
  const height = top + steps.length * row + 26;
  const x = (rate: number) => labelW + Math.max(0, Math.min(1, rate)) * plotW;
  return <svg className="pf-chart" viewBox={`0 0 ${width} ${height}`} width="100%" role="img" aria-label="Mistake rate per step">
    {[0, 0.25, 0.5, 0.75, 1].map((tick) => <g key={tick}><line x1={x(tick)} x2={x(tick)} y1={top - 4} y2={top + steps.length * row} stroke={GRID} strokeWidth={1} /><text x={x(tick)} y={height - 8} fill={MUTED} fontSize={10} textAnchor="middle">{pct(tick)}</text></g>)}
    <line x1={x(threshold)} x2={x(threshold)} y1={top - 4} y2={top + steps.length * row} stroke="#4fd8ff" strokeWidth={1} strokeDasharray="3 3" />
    <text x={x(threshold) + 4} y={top + 6} fill="#4fd8ff" fontSize={9}>critic threshold</text>
    {steps.map((step, index) => {
      const y = top + index * row, hot = highlight.includes(step.stepId);
      const reasons = Object.entries(step.byReason).filter(([, count]) => count).map(([reason, count]) => `${reason} ${count}`).join(", ");
      return <g key={step.stepId}>
        <title>{`${step.title}: ${step.attempts ? `${pct(step.mistakeRate)} of ${step.attempts} sessions (${step.sessionsWithMistake}) had a mistake; ${step.mistakes} mistakes${reasons ? ` (${reasons})` : ""}; median ${(step.medianMs / 1000).toFixed(1)} s` : "no attempts yet"}`}</title>
        <rect x={0} y={y} width={width} height={row} fill="transparent" />
        <text x={labelW - 12} y={y + row / 2 + 4} fill={hot ? INK : "#b9c6cf"} fontSize={12} fontWeight={hot ? 700 : 400} textAnchor="end" fontFamily="Manrope, system-ui, sans-serif">{`${index + 1}. ${step.title.length > 28 ? `${step.title.slice(0, 27)}…` : step.title}`}</text>
        <rect x={labelW} y={y + 8} width={plotW} height={row - 16} fill={TRACK} rx={4} />
        {step.mistakeRate > 0 && <rect x={labelW} y={y + 8} width={Math.max(4, x(step.mistakeRate) - labelW)} height={row - 16} fill={AMBER} opacity={hot ? 1 : 0.55} rx={4} />}
        <text x={labelW + plotW + 10} y={y + row / 2 + 4} fill={step.attempts ? INK : MUTED} fontSize={11}>{step.attempts ? `${pct(step.mistakeRate)} · ${step.sessionsWithMistake}/${step.attempts}` : "—"}</text>
      </g>;
    })}
  </svg>;
}

// Small grouped bars: mistake rate per step for each version (fixed categorical order by version, oldest first).
const SERIES = ["#3987e5", "#d95926", "#199e70", "#c98500"];
export function VersionBars({ steps, versions }: { steps: Array<{ stepId: string; title: string }>; versions: Array<{ version: string; runs: number; steps: Array<{ stepId: string; mistakeRate: number; attempts: number }> }> }) {
  const shown = versions.slice(-SERIES.length);
  const bar = 7, gap = 2, group = shown.length * (bar + gap) + 10, labelW = 210, width = 760, plotW = width - labelW - 60, top = 4;
  const height = top + steps.length * group + 22;
  return <>
    <div className="pf-legend">{shown.map((v, index) => <span key={v.version}><i style={{ background: SERIES[index] }} />v{v.version} · {v.runs} runs</span>)}</div>
    <svg className="pf-chart" viewBox={`0 0 ${width} ${height}`} width="100%" role="img" aria-label="Mistake rate per step by scenario version">
      {[0, 0.5, 1].map((tick) => <g key={tick}><line x1={labelW + tick * plotW} x2={labelW + tick * plotW} y1={0} y2={top + steps.length * group} stroke={GRID} /><text x={labelW + tick * plotW} y={height - 6} fill={MUTED} fontSize={10} textAnchor="middle">{pct(tick)}</text></g>)}
      {steps.map((step, index) => {
        const y = top + index * group;
        return <g key={step.stepId}>
          <text x={labelW - 12} y={y + group / 2 + 2} fill="#b9c6cf" fontSize={11} textAnchor="end" fontFamily="Manrope, system-ui, sans-serif">{step.title.length > 28 ? `${step.title.slice(0, 27)}…` : step.title}</text>
          {shown.map((v, vi) => {
            const stat = v.steps.find((item) => item.stepId === step.stepId);
            const rate = stat?.mistakeRate ?? 0;
            return <g key={v.version}><title>{`v${v.version} · ${step.title}: ${stat?.attempts ? `${pct(rate)} of ${stat.attempts} sessions` : "no attempts"}`}</title>
              <rect x={labelW} y={y + 4 + vi * (bar + gap)} width={plotW} height={bar} fill="transparent" />
              <rect x={labelW} y={y + 4 + vi * (bar + gap)} width={Math.max(rate > 0 ? 3 : 0, rate * plotW)} height={bar} rx={3} fill={SERIES[vi]} /></g>;
          })}
        </g>;
      })}
    </svg>
  </>;
}
