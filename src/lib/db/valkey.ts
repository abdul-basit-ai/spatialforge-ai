import Valkey from "iovalkey";
import { trustedCa } from "./tls";

const globalRef = globalThis as typeof globalThis & { __sfValkey?: Valkey | null };

export const VALKEY_KEYS = {
  criticQueue: "sf:critic:jobs",
  session: (id: string) => `sf:session:${id}`,
};
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
