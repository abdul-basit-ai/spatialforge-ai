import { create } from "zustand";
import { getScenario, partFor, type PartId, type PlacementMethod, type ScenarioId } from "@/lib/assembly";
import { telemetrySession, telemetryStamp } from "@/lib/telemetry";

export type Placement = { scenario: ScenarioId; partId: PartId; targetId: PartId; rotation: number; method: PlacementMethod; at: string };
export type ErrorEvent = { scenario: ScenarioId; partId: PartId; attemptedTarget?: PartId; kind: "wrong-target" | "orientation" | "prerequisite" | "tracking-lost"; prerequisite?: PartId; at: string };

type State = {
  operator: string;
  scenario: ScenarioId;
  placements: Placement[];
  errors: ErrorEvent[];
  passport: string | null;
  hydrate: () => void;
  setOperator: (operator: string) => void;
  setScenario: (scenario: ScenarioId) => void;
  markComplete: (partId: PartId, rotation: number, method: PlacementMethod) => void;
  unplace: (partId: PartId) => void;
  recordError: (partId: PartId, kind: ErrorEvent["kind"], attemptedTarget?: PartId, prerequisite?: PartId) => void;
  reset: () => void;
};

const keyFor = (operator: string, scenario: ScenarioId) => `spatialforge:run:${operator}:${scenario}`;

function send(path: string, body: unknown) {
  fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => undefined);
}

const sendEvent = (event: Record<string, unknown>) => send("/api/events", { ...event, ...telemetryStamp() });

function readRun(operator: string, scenario: ScenarioId) {
  if (typeof window === "undefined") return { placements: [], errors: [], passport: null };
  let saved = localStorage.getItem(keyFor(operator, scenario));
  if (!saved && scenario === "tray") {
    const legacy = localStorage.getItem(`spatialforge:run:${operator}`);
    if (legacy) {
      try {
        const old = JSON.parse(legacy) as { placements?: Array<{ slot?: PartId; method?: PlacementMethod; at?: string }>; errors?: Array<{ slot?: PartId; attemptedSlot?: PartId; kind?: string; at?: string }>; passport?: string | null };
        const placements = (old.placements || []).filter((item) => item.slot && partFor("tray", item.slot)).map((item) => ({ scenario: "tray" as const, partId: item.slot!, targetId: item.slot!, rotation: 0, method: item.method || "touch", at: item.at || new Date().toISOString() }));
        const errors = (old.errors || []).filter((item) => item.slot && partFor("tray", item.slot)).map((item) => ({ scenario: "tray" as const, partId: item.slot!, attemptedTarget: item.attemptedSlot, kind: item.kind === "tracking-lost" ? "tracking-lost" as const : "wrong-target" as const, at: item.at || new Date().toISOString() }));
        saved = JSON.stringify({ placements, errors, passport: old.passport || null });
        localStorage.setItem(keyFor(operator, "tray"), saved);
      } catch { /* Ignore malformed legacy data. */ }
    }
  }
  if (!saved) return { placements: [], errors: [], passport: null };
  try {
    const run = JSON.parse(saved) as { placements?: Placement[]; errors?: ErrorEvent[]; passport?: string | null };
    const allowed = new Set(getScenario(scenario).parts.map((part) => part.id));
    return {
      placements: (run.placements || []).filter((item) => item.scenario === scenario && allowed.has(item.partId) && allowed.has(item.targetId)),
      errors: (run.errors || []).filter((item) => item.scenario === scenario && allowed.has(item.partId)),
      passport: run.passport || null,
    };
  } catch { return { placements: [], errors: [], passport: null }; }
}

function persist(operator: string, scenario: ScenarioId, placements: Placement[], errors: ErrorEvent[], passport: string | null) {
  if (typeof window !== "undefined") localStorage.setItem(keyFor(operator, scenario), JSON.stringify({ placements, errors, passport }));
}

export const useAssemblyStore = create<State>((set, get) => ({
  operator: "7", scenario: "tray", placements: [], errors: [], passport: null,
  hydrate: () => {
    if (typeof window === "undefined") return;
    const operator = localStorage.getItem("spatialforge-operator") || "7";
    const storedScenario = localStorage.getItem("spatialforge-scenario");
    const scenario: ScenarioId = storedScenario === "valve" || storedScenario === "pneumatic" ? storedScenario : "tray";
    const run = readRun(operator, scenario);
    set({ operator, scenario, ...run });
  },
  setOperator: (operator) => {
    if (!/^[0-9]$/.test(operator)) return;
    localStorage.setItem("spatialforge-operator", operator);
    const scenario = get().scenario;
    set({ operator, ...readRun(operator, scenario) });
  },
  setScenario: (scenario) => {
    localStorage.setItem("spatialforge-scenario", scenario);
    const operator = get().operator;
    set({ scenario, ...readRun(operator, scenario) });
  },
  markComplete: (partId, rotation, method) => {
    const state = get();
    const part = partFor(state.scenario, partId);
    if (!part || state.placements.some((placement) => placement.partId === partId)) return;
    const placement: Placement = { scenario: state.scenario, partId, targetId: part.target, rotation, method, at: new Date().toISOString() };
    const placements = [...state.placements, placement];
    set({ placements, passport: null });
    persist(state.operator, state.scenario, placements, state.errors, null);
    sendEvent({ type: "placement_verified", scenario: state.scenario, operator: state.operator, partId, targetId: part.target, rotation, method, at: placement.at });
    if (placements.length !== getScenario(state.scenario).parts.length) return;
    const { sessionId, dagVersion } = telemetrySession();
    const evidence = { operator: state.operator, scenario: state.scenario, dagVersion, placements, completedAt: new Date().toISOString(), identity: "self-declared" };
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(evidence))).then((digest) => {
      const passport = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
      set({ passport });
      persist(state.operator, state.scenario, placements, get().errors, passport);
      send("/api/passports", { operator: state.operator, scenario: state.scenario, dagVersion, sessionId, sha256: passport, evidence });
    }).catch(() => undefined);
  },
  unplace: (partId) => {
    const state = get();
    const placement = state.placements.find((item) => item.partId === partId);
    if (!placement) return;
    const placements = state.placements.filter((item) => item.partId !== partId);
    set({ placements, passport: null });
    persist(state.operator, state.scenario, placements, state.errors, null);
    sendEvent({ type: "placement_removed", scenario: state.scenario, operator: state.operator, partId, targetId: placement.targetId, rotation: placement.rotation, at: new Date().toISOString() });
  },
  recordError: (partId, kind, attemptedTarget, prerequisite) => {
    const state = get();
    const event: ErrorEvent = { scenario: state.scenario, partId, attemptedTarget, prerequisite, kind, at: new Date().toISOString() };
    const errors = [...state.errors, event];
    set({ errors });
    persist(state.operator, state.scenario, state.placements, errors, state.passport);
    sendEvent({ type: kind, scenario: state.scenario, operator: state.operator, partId, attemptedTarget, prerequisite, at: event.at });
  },
  reset: () => {
    const state = get();
    if (typeof window !== "undefined") localStorage.removeItem(keyFor(state.operator, state.scenario));
    set({ placements: [], errors: [], passport: null });
  },
}));
