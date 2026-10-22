import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin";
import { errorMessage } from "@/lib/db/tls";
import { getScenario, listScenarios, type ScenarioSummary } from "@/lib/forge/repo";
import { BUILTIN_SCENARIOS, builtinScenario } from "@/lib/forge/samples";
import type { ForgeScenario } from "@/lib/forge/types";
import { validateScenario } from "@/lib/forge/validate";

// Shared server helpers for the scenario list/get/save/publish routes.

export type ListedScenario = ScenarioSummary & { builtin: boolean; issues?: number }; // issues: known for builtins only (stored summaries do not carry them)

const summarize = (s: ForgeScenario, builtin: boolean): ListedScenario => ({ id: s.id, version: s.version, status: s.status, title: s.title, summary: s.summary, domain: s.domain, parts: s.parts.length, steps: s.steps.length, source: s.source.kind, updatedAt: s.updatedAt, builtin, issues: validateScenario(s).length });

// DB scenarios merged with builtins; a stored scenario with the same id overrides the builtin.
export async function listAll(publishedOnly: boolean): Promise<ListedScenario[]> {
  const stored = await listScenarios({ publishedOnly }).catch((error) => { console.error("scenarios: list failed", errorMessage(error)); return [] as ScenarioSummary[]; });
  const byId = new Map<string, ListedScenario>();
  for (const s of BUILTIN_SCENARIOS) if (!publishedOnly || s.status === "published") byId.set(s.id, summarize(s, true));
  for (const s of stored) byId.set(s.id, { ...s, builtin: Boolean(builtinScenario(s.id)) });
  return [...byId.values()].sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
}

// Latest stored version (published only when asked), falling back to the builtin.
export async function resolveScenario(id: string, options: { version?: number; publishedOnly?: boolean } = {}): Promise<{ scenario: ForgeScenario; builtin: boolean; stored: boolean } | null> {
  const stored = await getScenario(id, options);
  if (stored) return { scenario: stored, builtin: Boolean(builtinScenario(id)), stored: true };
  const builtin = builtinScenario(id);
  if (builtin && (!options.version || builtin.version === options.version) && (!options.publishedOnly || builtin.status === "published")) return { scenario: builtin, builtin: true, stored: false };
  return null;
}

// Highest published version known for this id (stored or builtin), 0 when never published.
export async function publishedVersion(id: string): Promise<number> {
  const stored = await getScenario(id, { publishedOnly: true });
  const builtin = builtinScenario(id);
  return Math.max(stored?.version ?? 0, builtin?.status === "published" ? builtin.version : 0);
}

// Drafts keep their version unless that would overwrite a published version; then they move to the next one.
export async function draftVersion(id: string, requested: number): Promise<number> {
  const published = await publishedVersion(id);
  return Math.max(requested || 1, published + 1);
}

export const validId = (id: string) => /^[a-z0-9][a-z0-9-]{0,59}$/.test(id);

export const failure = (scope: string, error: unknown) => { console.error(`scenarios: ${scope}`, errorMessage(error)); return NextResponse.json({ error: "Scenario store unavailable" }, { status: 502 }); };

// Publishing needs the admin: ADMIN_TOKEN bearer, or a signed-in operator with role admin (via /api/auth/me when the people role ships it).
export async function authorizePublish(request: Request): Promise<{ ok: true; by: string } | { ok: false; response: NextResponse }> {
  const denied = requireAdmin(request);
  if (!denied) return { ok: true, by: "admin-token" };
  const operator = await signedInOperator(request);
  if (operator?.role === "admin") return { ok: true, by: operator.id || operator.name || "admin" };
  return { ok: false, response: denied };
}

type Operator = { id?: string; name?: string; role?: string };

async function signedInOperator(request: Request): Promise<Operator | null> {
  const cookie = request.headers.get("cookie");
  if (!cookie) return null;
  try {
    const response = await fetch(new URL("/api/auth/me", request.url), { headers: { cookie }, cache: "no-store", signal: AbortSignal.timeout(2500) });
    if (!response.ok) return null;
    const body = await response.json().catch(() => null) as Record<string, unknown> | null;
    const candidate = (body?.operator ?? body?.user ?? body) as Record<string, unknown> | null;
    if (!candidate || typeof candidate !== "object") return null;
    return { id: typeof candidate.id === "string" ? candidate.id : undefined, name: typeof candidate.name === "string" ? candidate.name : typeof candidate.displayName === "string" ? candidate.displayName : undefined, role: typeof candidate.role === "string" ? candidate.role : undefined };
  } catch { return null; }
}
