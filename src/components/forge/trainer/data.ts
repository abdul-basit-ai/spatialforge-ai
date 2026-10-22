"use client";

import { BUILTIN_SCENARIOS, builtinScenario } from "@/lib/forge/samples";
import type { ForgeScenario } from "@/lib/forge/types";
import { FIXTURE_SCENARIOS } from "./fixtures";

// Client data access for the trainer. Every call degrades gracefully: the API routes are built by other agents,
// so failures fall back to the built-in scenarios (or the local fixture when none are bundled yet).

export type ScenarioCard = { id: string; version: number; status: ForgeScenario["status"]; title: string; summary: string; domain: ForgeScenario["domain"]; parts: number; steps: number; source: string; approximation?: boolean; updatedAt?: string };
export type Operator = { id: string; name: string; source: "account" | "local" };

const localScenarios = () => (BUILTIN_SCENARIOS.length ? BUILTIN_SCENARIOS : FIXTURE_SCENARIOS);
const toCard = (s: ForgeScenario): ScenarioCard => ({ id: s.id, version: s.version, status: s.status, title: s.title, summary: s.summary, domain: s.domain, parts: s.parts.length, steps: s.steps.length, source: s.source.kind, approximation: s.source.approximation, updatedAt: s.updatedAt });

function asCard(value: unknown): ScenarioCard | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== "string" || typeof v.title !== "string") return null;
  const count = (x: unknown) => (Array.isArray(x) ? x.length : typeof x === "number" ? x : 0);
  const source = typeof v.source === "string" ? v.source : (v.source as { kind?: string } | undefined)?.kind ?? "upload";
  return { id: v.id, version: Number(v.version) || 1, status: v.status === "draft" ? "draft" : "published", title: v.title, summary: typeof v.summary === "string" ? v.summary : "", domain: v.domain === "mechanical" ? "mechanical" : "mechatronic", parts: count(v.parts), steps: count(v.steps), source, approximation: typeof v.approximation === "boolean" ? v.approximation : (v.source as { approximation?: boolean } | undefined)?.approximation, updatedAt: typeof v.updatedAt === "string" ? v.updatedAt : undefined };
}

export async function fetchScenarioCards(): Promise<{ cards: ScenarioCard[]; live: boolean }> {
  const local = localScenarios().map(toCard);
  try {
    const response = await fetch("/api/forge/scenarios", { cache: "no-store" });
    if (!response.ok) throw new Error(String(response.status));
    const json = await response.json() as unknown;
    const list = Array.isArray(json) ? json : (json as { scenarios?: unknown[] }).scenarios ?? [];
    const cards = list.map(asCard).filter((card): card is ScenarioCard => Boolean(card));
    const ids = new Set(cards.map((card) => card.id));
    return { cards: [...cards, ...local.filter((card) => !ids.has(card.id))], live: true };
  } catch {
    return { cards: local, live: false };
  }
}

const isScenario = (value: unknown): value is ForgeScenario => Boolean(value && typeof value === "object" && Array.isArray((value as ForgeScenario).parts) && Array.isArray((value as ForgeScenario).steps) && typeof (value as ForgeScenario).id === "string");

export async function fetchScenario(id: string): Promise<{ scenario: ForgeScenario | null; from: "api" | "builtin" | "fixture" | null }> {
  try {
    const response = await fetch(`/api/forge/scenarios/${encodeURIComponent(id)}`, { cache: "no-store" });
    if (response.ok) {
      const json = await response.json() as unknown;
      const scenario = isScenario(json) ? json : (json as { scenario?: unknown }).scenario;
      if (isScenario(scenario)) return { scenario: { ...scenario, baseParts: scenario.baseParts ?? [] }, from: "api" };
    }
  } catch { /* fall back below */ }
  const builtin = builtinScenario(id);
  if (builtin) return { scenario: builtin, from: "builtin" };
  const fixture = FIXTURE_SCENARIOS.find((scenario) => scenario.id === id) ?? null;
  return { scenario: fixture, from: fixture ? "fixture" : null };
}

// ---- operator identity ----
const LOCAL_KEY = "forge.operator";
const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "operator";

export function localOperator(): Operator | null {
  try {
    const raw = window.localStorage.getItem(LOCAL_KEY);
    const parsed = raw ? JSON.parse(raw) as { id?: string; name?: string } : null;
    return parsed?.id && parsed.name ? { id: parsed.id, name: parsed.name, source: "local" } : null;
  } catch { return null; }
}

export function saveLocalOperator(name: string): Operator {
  const operator: Operator = { id: `local-${slug(name)}`, name: name.trim().slice(0, 60), source: "local" };
  try { window.localStorage.setItem(LOCAL_KEY, JSON.stringify({ id: operator.id, name: operator.name })); } catch { /* private mode */ }
  return operator;
}

export function clearLocalOperator() { try { window.localStorage.removeItem(LOCAL_KEY); } catch { /* ignore */ } }

// GET /api/auth/me (people agent). 404 / network failure: accounts are not available, use the local prompt.
export async function fetchMe(): Promise<{ me: Operator | null; authAvailable: boolean }> {
  try {
    const response = await fetch("/api/auth/me", { cache: "no-store", credentials: "same-origin" });
    if (response.status === 404) return { me: null, authAvailable: false };
    if (!response.ok) return { me: null, authAvailable: response.status === 401 || response.status === 403 };
    const json = await response.json() as Record<string, unknown>;
    const node = (json.operator ?? json.user ?? json) as Record<string, unknown> | null;
    const id = node && (node.id ?? node.operatorId ?? node.code);
    const name = node && (node.name ?? node.displayName ?? node.id);
    if (typeof id === "string" || typeof id === "number") return { me: { id: String(id), name: String(name ?? id), source: "account" }, authAvailable: true };
    return { me: null, authAvailable: true };
  } catch {
    return { me: null, authAvailable: false };
  }
}

// GET /api/forge/coach (people agent). Accepts { briefing, hints } with hints as a step map or a list; null on any failure.
export async function fetchCoach(scenarioId: string, operatorId: string): Promise<{ briefing: string | null; hints: Record<string, string[]> } | null> {
  try {
    const response = await fetch(`/api/forge/coach?scenarioId=${encodeURIComponent(scenarioId)}&operatorId=${encodeURIComponent(operatorId)}`, { cache: "no-store", signal: AbortSignal.timeout(20000) });
    if (!response.ok) return null;
    const json = await response.json() as { briefing?: unknown; hints?: unknown };
    const hints: Record<string, string[]> = {};
    const add = (stepId: unknown, value: unknown) => {
      if (typeof stepId !== "string") return;
      const list = (Array.isArray(value) ? value : [value]).filter((item): item is string => typeof item === "string" && Boolean(item.trim()));
      if (list.length) hints[stepId] = [...(hints[stepId] ?? []), ...list];
    };
    if (Array.isArray(json.hints)) for (const item of json.hints as Array<Record<string, unknown>>) add(item?.stepId, item?.hints ?? item?.hint ?? item?.text);
    else if (json.hints && typeof json.hints === "object") for (const [stepId, value] of Object.entries(json.hints)) add(stepId, value);
    const briefing = typeof json.briefing === "string" ? json.briefing : (json.briefing as { text?: string } | undefined)?.text ?? null;
    return { briefing, hints };
  } catch {
    return null;
  }
}
