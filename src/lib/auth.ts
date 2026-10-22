import { createHash, createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { NextResponse } from "next/server";
import { postgres } from "@/lib/db/postgres";
import { valkey, withTimeout } from "@/lib/db/valkey";
import { errorMessage } from "@/lib/db/tls";

// Operator identity for Forge: name + 4-6 digit PIN. The first sign-in with a new name registers the operator.
// Session = signed HttpOnly cookie sf_op (HMAC-SHA256 over the payload). Server-side only.
const scrypt = promisify(scryptCb) as (pin: string, salt: Buffer, keylen: number) => Promise<Buffer>;

export type OperatorRole = "trainee" | "admin";
export type Operator = { id: string; name: string; role: OperatorRole };
export type OperatorRecord = Operator & { pinHash: string; createdAt: string; lastSeenAt: string | null };

export const COOKIE_NAME = "sf_op";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30;
export const LOCKOUT = { maxFailures: 5, seconds: 300 };

export const normalizeName = (value: unknown) => typeof value === "string" ? value.normalize("NFKC").trim().replace(/\s+/g, " ") : "";
export const isValidName = (name: string) => /^[\p{L}\p{N}][\p{L}\p{N} .'_-]{1,31}$/u.test(name);
export const isValidPin = (pin: unknown): pin is string => typeof pin === "string" && /^\d{4,6}$/.test(pin);
export const isOperatorId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value);
const nameKey = (name: string) => name.toLowerCase();

// ---------- secret + cookie ----------
let devSecret: string | null = null;
function secret(): string {
  if (process.env.AUTH_SECRET) return process.env.AUTH_SECRET;
  if (!devSecret) {
    // Stable across restarts on the same machine/config, but never a hard-coded constant when secrets are configured.
    devSecret = createHash("sha256").update(`spatialforge-dev-auth:${process.env.DATABASE_URL ?? ""}:${process.env.OPENAI_API_KEY ?? ""}:${process.cwd()}`).digest("hex");
    console.warn("auth: AUTH_SECRET is not set; using a derived development secret for sf_op cookies. Set AUTH_SECRET in production.");
  }
  return devSecret;
}
const b64 = (value: Buffer | string) => Buffer.from(value).toString("base64url");
const sign = (body: string) => b64(createHmac("sha256", secret()).update(body).digest());

export function signOperator(operator: Operator, now = Date.now()): string {
  const body = b64(JSON.stringify({ id: operator.id, name: operator.name, role: operator.role, iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + COOKIE_MAX_AGE }));
  return `v1.${body}.${sign(body)}`;
}

export function verifyToken(token: string | undefined | null): Operator | null {
  if (!token) return null;
  const [version, body, mac] = token.split(".");
  if (version !== "v1" || !body || !mac) return null;
  const expected = Buffer.from(sign(body)), given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const data = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { id?: unknown; name?: unknown; role?: unknown; exp?: unknown };
    if (!isOperatorId(data.id) || typeof data.name !== "string" || typeof data.exp !== "number" || data.exp * 1000 < Date.now()) return null;
    return { id: data.id, name: data.name.slice(0, 32), role: data.role === "admin" ? "admin" : "trainee" };
  } catch { return null; }
}

export function readCookie(request: Request, name = COOKIE_NAME): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index > 0 && part.slice(0, index).trim() === name) return decodeURIComponent(part.slice(index + 1).trim());
  }
  return null;
}

// The signed-in operator for this request, or null. Synchronous (cookie + HMAC only); safe to `await` too.
export function getOperator(request: Request): Operator | null { return verifyToken(readCookie(request)); }

const isHttps = (request: Request) => request.headers.get("x-forwarded-proto") === "https" || new URL(request.url).protocol === "https:";
export function setOperatorCookie(response: NextResponse, request: Request, operator: Operator) {
  response.cookies.set(COOKIE_NAME, signOperator(operator), { httpOnly: true, sameSite: "lax", path: "/", maxAge: COOKIE_MAX_AGE, secure: isHttps(request) });
}
export function clearOperatorCookie(response: NextResponse, request: Request) {
  response.cookies.set(COOKIE_NAME, "", { httpOnly: true, sameSite: "lax", path: "/", maxAge: 0, secure: isHttps(request) });
}

// ---------- admin ----------
const digest = (value: string) => createHash("sha256").update(value).digest();
export function hasAdminToken(request: Request): boolean {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) return false;
  const header = request.headers.get("authorization");
  const provided = request.headers.get("x-admin-token") || (header?.startsWith("Bearer ") ? header.slice(7) : "");
  return Boolean(provided) && timingSafeEqual(digest(provided), digest(expected));
}
// ADMIN_TOKEN (bearer or x-admin-token) OR a signed-in operator with the admin role.
export function isAdminRequest(request: Request): boolean { return hasAdminToken(request) || getOperator(request)?.role === "admin"; }
export function adminDenied(request: Request): NextResponse | null {
  if (isAdminRequest(request)) return null;
  return NextResponse.json({ error: "Admin access required: sign in as an admin operator or send the ADMIN_TOKEN." }, { status: 401 });
}
// ADMIN_NAME names the admin operator. Unset: the operator named "admin" (first sign-in claims it).
export const isAdminName = (name: string) => nameKey(name) === nameKey(normalizeName(process.env.ADMIN_NAME || "admin"));

// ---------- PIN hashing ----------
export async function hashPin(pin: string): Promise<string> {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString("hex")}$${(await scrypt(pin, salt, 32)).toString("hex")}`;
}
export async function verifyPin(pin: string, stored: string): Promise<boolean> {
  const [scheme, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const actual = await scrypt(pin, Buffer.from(salt, "hex"), 32), expected = Buffer.from(hash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// ---------- operator store (PostgreSQL, in-memory fallback) ----------
const memory = globalThis as typeof globalThis & { __sfOperators?: Map<string, OperatorRecord>; __sfAuthFails?: Map<string, { count: number; expiresAt: number }> };
const memOperators = () => (memory.__sfOperators ??= new Map());
const memFails = () => (memory.__sfAuthFails ??= new Map());
type Row = { id: string; display_name: string; pin_hash: string; role: OperatorRole; created_at: Date | string; last_seen_at: Date | string | null };
const fromRow = (row: Row): OperatorRecord => ({ id: row.id, name: row.display_name, role: row.role === "admin" ? "admin" : "trainee", pinHash: row.pin_hash, createdAt: new Date(row.created_at).toISOString(), lastSeenAt: row.last_seen_at ? new Date(row.last_seen_at).toISOString() : null });

export async function findOperatorByName(name: string): Promise<OperatorRecord | null> {
  const db = postgres();
  if (!db) return [...memOperators().values()].find((item) => nameKey(item.name) === nameKey(name)) ?? null;
  const { rows } = await db.query("select id, display_name, pin_hash, role, created_at, last_seen_at from operators where lower(display_name) = lower($1) limit 1", [name]);
  return rows[0] ? fromRow(rows[0] as Row) : null;
}
export async function findOperatorById(id: string): Promise<OperatorRecord | null> {
  if (!isOperatorId(id)) return null;
  const db = postgres();
  if (!db) return memOperators().get(id) ?? null;
  const { rows } = await db.query("select id, display_name, pin_hash, role, created_at, last_seen_at from operators where id = $1", [id]);
  return rows[0] ? fromRow(rows[0] as Row) : null;
}
export async function listOperators(): Promise<OperatorRecord[]> {
  const db = postgres();
  if (!db) return [...memOperators().values()];
  const { rows } = await db.query("select id, display_name, pin_hash, role, created_at, last_seen_at from operators order by last_seen_at desc nulls last, created_at desc limit 500");
  return (rows as Row[]).map(fromRow);
}
async function createOperator(name: string, pin: string): Promise<OperatorRecord> {
  const record: OperatorRecord = { id: `op_${randomBytes(9).toString("base64url").replace(/[^A-Za-z0-9]/g, "x")}`, name, role: isAdminName(name) ? "admin" : "trainee", pinHash: await hashPin(pin), createdAt: new Date().toISOString(), lastSeenAt: new Date().toISOString() };
  const db = postgres();
  if (!db) { memOperators().set(record.id, record); return record; }
  const { rows } = await db.query("insert into operators (id, display_name, pin_hash, role, last_seen_at) values ($1,$2,$3,$4,now()) on conflict (display_name) do nothing returning id", [record.id, record.name, record.pinHash, record.role]);
  if (!rows[0]) throw new Error("name taken concurrently");
  return record;
}
export async function touchOperator(id: string, role?: OperatorRole) {
  const db = postgres();
  if (!db) { const item = memOperators().get(id); if (item) { item.lastSeenAt = new Date().toISOString(); if (role) item.role = role; } return; }
  await db.query("update operators set last_seen_at = now(), role = coalesce($2, role) where id = $1", [id, role ?? null]);
}
export async function setOperatorRole(id: string, role: OperatorRole): Promise<OperatorRecord | null> {
  const db = postgres();
  if (!db) { const item = memOperators().get(id); if (item) item.role = role; return item ?? null; }
  const { rows } = await db.query("update operators set role = $2 where id = $1 returning id, display_name, pin_hash, role, created_at, last_seen_at", [id, role]);
  return rows[0] ? fromRow(rows[0] as Row) : null;
}

// ---------- lockout (Valkey, in-memory fallback) ----------
const failKey = (name: string) => `sf:auth:fail:${createHash("sha1").update(nameKey(name)).digest("hex")}`;
async function failures(name: string): Promise<{ count: number; ttl: number }> {
  const cache = valkey(), key = failKey(name);
  if (cache) {
    try { const [count, ttl] = await withTimeout(Promise.all([cache.get(key), cache.ttl(key)])); return { count: Number(count) || 0, ttl: Math.max(0, ttl) }; }
    catch (error) { console.error("auth: lockout read failed", errorMessage(error)); }
  }
  const item = memFails().get(key);
  if (!item || item.expiresAt < Date.now()) return { count: 0, ttl: 0 };
  return { count: item.count, ttl: Math.ceil((item.expiresAt - Date.now()) / 1000) };
}
async function recordFailure(name: string): Promise<number> {
  const cache = valkey(), key = failKey(name);
  if (cache) {
    try {
      const count = await withTimeout(cache.incr(key));
      // The window starts at the first failure; reaching the limit restarts it so the lock lasts the full 5 minutes.
      if (count === 1 || count >= LOCKOUT.maxFailures) await withTimeout(cache.expire(key, LOCKOUT.seconds));
      return count;
    } catch (error) { console.error("auth: lockout write failed", errorMessage(error)); }
  }
  const now = Date.now(), item = memFails().get(key);
  const count = item && item.expiresAt > now ? item.count + 1 : 1;
  memFails().set(key, { count, expiresAt: count === 1 || count >= LOCKOUT.maxFailures ? now + LOCKOUT.seconds * 1000 : item!.expiresAt });
  return count;
}
async function clearFailures(name: string) {
  const cache = valkey(), key = failKey(name);
  memFails().delete(key);
  if (cache) await withTimeout(cache.del(key)).catch(() => undefined);
}

export type SignInResult =
  | { ok: true; operator: Operator; created: boolean }
  | { ok: false; status: 400 | 401 | 429 | 502; error: string; attemptsLeft?: number; retryAfter?: number };

// Registers on first use of a name, otherwise verifies the PIN. Lockout after 5 bad PINs for 5 minutes.
export async function signIn(rawName: unknown, pin: unknown): Promise<SignInResult> {
  const name = normalizeName(rawName);
  if (!isValidName(name)) return { ok: false, status: 400, error: "Use a name of 2 to 32 letters, digits, spaces or . ' _ -" };
  if (!isValidPin(pin)) return { ok: false, status: 400, error: "The PIN must be 4 to 6 digits." };
  try {
    const locked = await failures(name);
    if (locked.count >= LOCKOUT.maxFailures) return { ok: false, status: 429, error: `Too many wrong PINs. Try again in ${Math.ceil((locked.ttl || LOCKOUT.seconds) / 60)} min.`, retryAfter: locked.ttl || LOCKOUT.seconds, attemptsLeft: 0 };
    const existing = await findOperatorByName(name);
    if (!existing) {
      const created = await createOperator(name, pin).catch(async (error) => { if (errorMessage(error).includes("concurrently")) return null; throw error; });
      if (!created) return { ok: false, status: 401, error: "That name was just registered. Sign in with its PIN." };
      return { ok: true, operator: { id: created.id, name: created.name, role: created.role }, created: true };
    }
    if (!await verifyPin(pin, existing.pinHash)) {
      const count = await recordFailure(name);
      if (count >= LOCKOUT.maxFailures) return { ok: false, status: 429, error: `Too many wrong PINs. ${existing.name} is locked for ${LOCKOUT.seconds / 60} minutes.`, retryAfter: LOCKOUT.seconds, attemptsLeft: 0 };
      return { ok: false, status: 401, error: "Wrong PIN.", attemptsLeft: LOCKOUT.maxFailures - count };
    }
    await clearFailures(name);
    const role: OperatorRole = existing.role === "admin" || isAdminName(existing.name) ? "admin" : "trainee";
    await touchOperator(existing.id, role !== existing.role ? role : undefined).catch((error) => console.error("auth: touch failed", errorMessage(error)));
    return { ok: true, operator: { id: existing.id, name: existing.name, role }, created: false };
  } catch (error) {
    console.error("auth: sign-in failed", errorMessage(error));
    return { ok: false, status: 502, error: "Operator store unavailable. Try again." };
  }
}
