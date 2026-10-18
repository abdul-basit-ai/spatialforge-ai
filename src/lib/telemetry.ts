import type { SpatialEvent } from "@/lib/spatial-engine";

const QUEUE_KEY = "spatialforge:telemetry:v1";

function readQueue(): SpatialEvent[] {
  if (typeof window === "undefined") return [];
  try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || "[]") as SpatialEvent[]; } catch { return []; }
}

function writeQueue(events: SpatialEvent[]) { if (typeof window !== "undefined") localStorage.setItem(QUEUE_KEY, JSON.stringify(events.slice(-500))); }

export function queueSpatialEvent(event: SpatialEvent) {
  const queue = readQueue(); queue.push(event); writeQueue(queue);
  void flushSpatialEvents();
}

export async function flushSpatialEvents() {
  const queue = readQueue();
  if (!queue.length || typeof window === "undefined") return;
  try {
    const response = await fetch("/api/events", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ events: queue }) });
    if (response.ok) writeQueue([]);
  } catch { /* Keep the queue for the next online attempt. */ }
}

export function clearTelemetryQueue() { writeQueue([]); }
