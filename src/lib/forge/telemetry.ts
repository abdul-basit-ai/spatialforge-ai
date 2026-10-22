"use client";

import type { ForgeEvent } from "./types";

// Client telemetry for Forge runs. Contract: trackForge() stamps sequence + time and posts to /api/events.
// Events are batched (flushed every 1.5 s, at once for mistakes and session completion, and on page hide) and
// queued in localStorage while offline, so a dropped connection does not lose a run. The server takes the operator
// from the sf_op cookie; operatorId in the body is only a fallback for signed-out use.
const QUEUE_KEY = "spatialforge:forge-events:v1";
const FLUSH_MS = 1500, MAX_QUEUE = 2000, MAX_BATCH = 200;
let sequence = 0;
let queue: ForgeEvent[] | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let flushing = false;

const load = (): ForgeEvent[] => {
  if (queue) return queue;
  try { queue = JSON.parse(localStorage.getItem(QUEUE_KEY) || "[]") as ForgeEvent[]; } catch { queue = []; }
  if (typeof window !== "undefined") {
    window.addEventListener("online", () => void flushForge());
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") void flushForge(true); });
  }
  return queue;
};
const save = () => { try { localStorage.setItem(QUEUE_KEY, JSON.stringify((queue ?? []).slice(-MAX_QUEUE))); } catch { /* storage full or blocked */ } };

export function trackForge(event: Omit<ForgeEvent, "sequence" | "at">) {
  const full: ForgeEvent = { ...event, operatorId: event.operatorId || cachedOperator?.id || "", sequence: ++sequence, at: new Date().toISOString() };
  if (typeof window === "undefined") return;
  const list = load();
  list.push(full);
  if (list.length > MAX_QUEUE) list.splice(0, list.length - MAX_QUEUE);
  save();
  const urgent = full.type === "forge_session_completed" || full.type === "forge_mistake" || full.type === "forge_session_started";
  if (urgent) void flushForge(full.type === "forge_session_completed");
  else if (!timer) timer = setTimeout(() => void flushForge(), FLUSH_MS);
}

// Sends everything queued. Returns true when the queue is empty afterwards.
export async function flushForge(keepalive = false): Promise<boolean> {
  if (timer) { clearTimeout(timer); timer = null; }
  if (typeof window === "undefined" || flushing) return false;
  const list = load();
  if (!list.length) return true;
  flushing = true;
  try {
    while (list.length) {
      const batch = list.slice(0, MAX_BATCH);
      const response = await fetch("/api/events", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ events: batch }), keepalive: keepalive && JSON.stringify(batch).length < 60000, credentials: "same-origin" });
      if (!response.ok && response.status !== 400 && response.status !== 413) throw new Error(`events ${response.status}`); // 400/413: drop, never retry forever
      list.splice(0, batch.length);
      save();
    }
    return true;
  } catch {
    if (!timer) timer = setTimeout(() => void flushForge(), 10000); // retry later (offline / server down)
    return false;
  } finally { flushing = false; }
}

// ---------- signed-in operator (client helpers for the trainer and AR modes) ----------
export type ForgeOperator = { id: string; name: string; role: "trainee" | "admin" };
let cachedOperator: ForgeOperator | null = null;
let pending: Promise<ForgeOperator | null> | null = null;

// The signed-in operator from /api/auth/me (cached), or null when signed out.
export function currentOperator(refresh = false): Promise<ForgeOperator | null> {
  if (typeof window === "undefined") return Promise.resolve(null);
  if (!refresh && pending) return pending;
  pending = fetch("/api/auth/me", { credentials: "same-origin" }).then((response) => response.ok ? response.json() : null).then((body) => (cachedOperator = body?.operator ?? null)).catch(() => null);
  return pending;
}
export const signInHref = (next = typeof window === "undefined" ? "/train" : window.location.pathname + window.location.search) => `/signin?next=${encodeURIComponent(next)}`;
export async function signOut() { await fetch("/api/auth/signout", { method: "POST" }).catch(() => undefined); cachedOperator = null; pending = null; }

export type ForgeCoachBriefing = { briefing: string; hints: Record<string, string>; focusSteps: string[]; source: "llm" | "rules" | "default"; version: number | null; cached: boolean };
// Pre-run (or mid-run) Coach briefing for the signed-in operator. Never throws; null when unavailable.
export async function fetchCoach(scenarioId: string, options: { fresh?: boolean } = {}): Promise<ForgeCoachBriefing | null> {
  try {
    const response = await fetch(`/api/forge/coach?scenarioId=${encodeURIComponent(scenarioId)}${options.fresh ? "&fresh=1" : ""}`, { credentials: "same-origin" });
    return response.ok ? await response.json() as ForgeCoachBriefing : null;
  } catch { return null; }
}
