import Valkey from "iovalkey";
import { trustedCa } from "./tls";

const globalRef = globalThis as typeof globalThis & { __sfValkey?: Valkey | null };

export const VALKEY_KEYS = {
  criticQueue: "sf:critic:jobs",
  criticFailed: "sf:critic:failed",
  session: (id: string) => `sf:session:${id}`,
  activeGuidance: (scenario: string) => `sf:guidance:${scenario}`,
  coach: (scenario: string, version: string, operator: string) => `sf:coach:${scenario}:${version}:${operator}`,
  coachPattern: (scenario: string) => `sf:coach:${scenario}:*`,
  llmRate: (scope: string, minute: number) => `sf:rl:llm:${scope}:${minute}`,
};

// Cache calls must never stall a request: give up after a short wait and carry on without the cache.
export function withTimeout<T>(promise: Promise<T>, ms = 1500): Promise<T> {
  return Promise.race([promise, new Promise<T>((_, reject) => setTimeout(() => reject(new Error("valkey timeout")), ms))]);
}

// Fixed-window limiter for LLM calls. When Valkey is missing or down, the caller decides (agents fall back to rules).
export async function allowLlmCall(client: Valkey | null, scope: string, perMinute: number): Promise<boolean> {
  if (!client) return true;
  try {
    const key = VALKEY_KEYS.llmRate(scope, Math.floor(Date.now() / 60000));
    const [[, count]] = await withTimeout(client.multi().incr(key).expire(key, 120).exec() as Promise<Array<[Error | null, number]>>);
    return Number(count) <= perMinute;
  } catch { return true; }
}
export const LIVE_SESSION_TTL_SECONDS = 60 * 60 * 24;

// Shared client, or null when VALKEY_URL is unset. Use rediss:// for Aiven (TLS).
export function valkey(): Valkey | null {
  if (globalRef.__sfValkey !== undefined) return globalRef.__sfValkey;
  const url = process.env.VALKEY_URL;
  if (!url) return (globalRef.__sfValkey = null);
  const client = new Valkey(url, {
    lazyConnect: true, connectTimeout: 5000, maxRetriesPerRequest: 1, enableOfflineQueue: true,
    retryStrategy: (times) => Math.min(times * 500, 5000),
    tls: url.startsWith("rediss:") ? { ca: trustedCa() } : undefined,
  });
  client.on("error", (error) => console.error("valkey error", error.message));
  return (globalRef.__sfValkey = client);
}

export type CriticJob = { sessionId: string; operator: string; scenario: string; dagVersion: string; completedAt: string; queuedAt: string };
