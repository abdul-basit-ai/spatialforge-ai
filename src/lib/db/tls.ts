import { readFileSync } from "node:fs";
import { rootCertificates } from "node:tls";

let cached: string | null | undefined;

// AIVEN_CA_CERT may hold the PEM itself (optionally with literal "\n") or a path to ca.pem.
export function aivenCa(): string | null {
  if (cached !== undefined) return cached;
  const raw = process.env.AIVEN_CA_CERT?.trim();
  if (!raw) return (cached = null);
  try { cached = raw.includes("BEGIN CERTIFICATE") ? raw.replace(/\\n/g, "\n") : readFileSync(raw, "utf8"); }
  catch { console.error("AIVEN_CA_CERT is set but could not be read; continuing without a custom CA"); cached = null; }
  return cached;
}

// Trust the Aiven project CA in addition to public roots, so services with either kind of certificate verify.
export function trustedCa(): string[] | undefined {
  const ca = aivenCa();
  return ca ? [...rootCertificates, ca] : undefined;
}

export function errorMessage(error: unknown) { return error instanceof Error ? error.message : String(error); }
