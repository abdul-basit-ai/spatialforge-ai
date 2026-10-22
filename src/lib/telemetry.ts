import { DEFAULT_DAG_VERSION, makeSessionId, type SpatialEvent } from "@/lib/spatial-engine";

const QUEUE_KEY = "spatialforge:telemetry:v1";

// Shared session context so page events and store events carry the same sessionId, ordered sequence, and dagVersion.
let session = { sessionId: makeSessionId(), sequence: 0, dagVersion: DEFAULT_DAG_VERSION };
export function startTelemetrySession(sessionId: string, dagVersion = DEFAULT_DAG_VERSION) { session = { sessionId, sequence: 0, dagVersion }; }
export function telemetrySession() { return { sessionId: session.sessionId, dagVersion: session.dagVersion }; }
export function telemetryStamp() { return { sessionId: session.sessionId, sequence: ++session.sequence, dagVersion: session.dagVersion }; }

function readQueue(): SpatialEvent[] {
  if (typeof window === "undefined") return [];
  try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || "[]") as SpatialEvent[]; } catch { return []; }
}

function writeQueue(events: SpatialEvent[]) { if (typeof window !== "undefined") localStorage.setItem(QUEUE_KEY, JSON.stringify(events.slice(-500))); }

export function queueSpatialEvent(event: SpatialEvent) {
  const queue = readQueue(); queue.push(event); writeQueue(queue);
  void flushSpatialEvents();
}

// One flush at a time; on success only the events that were sent are removed, so events queued meanwhile go in the
// next batch and nothing is inserted twice.
const eventKey = (event: SpatialEvent) => `${event.sessionId}:${event.sequence}:${event.type}`;
let flushing: Promise<void> | null = null, flushAgain = false;
export async function flushSpatialEvents(): Promise<void> {
  if (typeof window === "undefined") return;
  if (flushing) { flushAgain = true; return flushing; }
  flushing = (async () => {
    do {
      flushAgain = false;
      const batch = readQueue();
      if (!batch.length) break;
      try {
        const response = await fetch("/api/events", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ events: batch }) });
        if (!response.ok) break;
        const sent = new Set(batch.map(eventKey));
        writeQueue(readQueue().filter((event) => !sent.has(eventKey(event))));
      } catch { break; /* Keep the queue for the next online attempt. */ }
    } while (flushAgain);
  })().finally(() => { flushing = null; });
  return flushing;
}

export function clearTelemetryQueue() { writeQueue([]); }
