"use client";

import type { ForgeEvent } from "./types";

// Client telemetry for Forge runs. Contract: trackForge() stamps sequence + time and posts to /api/events.
// The memory agent owns server acceptance and may add batching/offline queueing behind this same signature.
let sequence = 0;

export function trackForge(event: Omit<ForgeEvent, "sequence" | "at">) {
  const full: ForgeEvent = { ...event, sequence: ++sequence, at: new Date().toISOString() };
  if (typeof window === "undefined") return;
  void fetch("/api/events", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ events: [full] }), keepalive: true }).catch(() => undefined);
}
