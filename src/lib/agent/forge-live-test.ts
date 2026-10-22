// Live end-to-end test for Forge people/memory/learning. Not part of the app bundle.
// Usage: start the dev server with ADMIN_TOKEN and ADMIN_NAME set, then
//   BASE=http://localhost:3208 ADMIN_TOKEN=... ADMIN_NAME=... npx tsx src/lib/agent/forge-live-test.ts
import { randomUUID } from "node:crypto";
import { loadEnv } from "../../../scripts/env";
import { clickhouse } from "@/lib/db/clickhouse";
import { postgres } from "@/lib/db/postgres";
import { valkey } from "@/lib/db/valkey";
import { getScenario, saveScenario } from "@/lib/forge/repo";
import { fixtureScenario } from "./forge-fixture";

loadEnv();
const BASE = process.env.BASE || "http://localhost:3208";
const ADMIN = process.env.ADMIN_TOKEN || "";
const RUN = Date.now().toString(36);
const SCENARIO = `people-fixture-${RUN}`;
let failures = 0;
const check = (label: string, ok: boolean, detail?: unknown) => { if (!ok) failures++; console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail !== undefined ? ` :: ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 600)}` : ""}`); };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function http(path: string, init: RequestInit & { cookie?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.cookie) headers.set("cookie", init.cookie);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(`${BASE}${path}`, { ...init, headers });
  const text = await response.text();
  let json: any = null; try { json = JSON.parse(text); } catch { json = text; }
  const cookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";
  return { status: response.status, json, cookie };
}

type Ev = Record<string, unknown>;
function session(opts: { operatorId: string; version: number; mistakes: (stepId: string) => Array<{ reason: string; partId?: string }>; slow?: (stepId: string) => number; start: number; complete?: boolean; mode?: string }) {
  const steps = ["s1-ring", "s2-sun", "s3-carrier", "s4-cover", "s5-screws", "s6-torque", "s7-inspect"];
  const sessionId = randomUUID(), events: Ev[] = [];
  let t = opts.start, seq = 0;
  const base = { scenarioId: SCENARIO, scenarioVersion: opts.version, sessionId, operatorId: opts.operatorId, mode: opts.mode ?? "3d" };
  const push = (type: string, extra: Ev = {}) => events.push({ ...base, type, sequence: ++seq, at: new Date(t).toISOString(), ...extra });
  push("forge_session_started");
  for (const [index, stepId] of steps.entries()) {
    if (opts.complete === false && index === 3) { push("forge_step_started", { stepId }); break; }
    push("forge_step_started", { stepId });
    const started = t;
    for (const mistake of opts.mistakes(stepId)) { t += 4000; push("forge_mistake", { stepId, reason: mistake.reason, partId: mistake.partId, message: `test ${mistake.reason}` }); t += 1500; push("forge_hint_shown", { stepId }); }
    t += 6000 + index * 900 + (opts.slow?.(stepId) ?? 0);
    push("forge_step_completed", { stepId, ms: t - started });
  }
  if (opts.complete !== false) { t += 1000; push("forge_session_completed", { ms: t - opts.start }); }
  return { sessionId, events, end: t };
}

async function main() {
  console.log(`BASE ${BASE} scenario ${SCENARIO}`);
  const fixture = await saveScenario(fixtureScenario(SCENARIO), "people-live-test");
  check("fixture scenario saved v1 published", fixture.version === 1 && (await getScenario(SCENARIO, { publishedOnly: true }))?.version === 1);

  // ---- auth ----
  const names = ["Ava", "Ben", "Chloe", "Dev", "Eli", "Farah"].map((name) => `${name} QA${RUN.slice(-4)}`);
  const pins = ["4821", "73915", "246810", "1357", "908172", "5555"];
  const cookies: string[] = [], ids: string[] = [];
  for (const [index, name] of names.entries()) {
    const signup = await http("/api/auth/signin", { method: "POST", body: JSON.stringify({ name, pin: pins[index] }) });
    check(`signup ${name}`, signup.status === 200 && signup.json.created === true && /^op_/.test(signup.json.operator.id) && signup.cookie.startsWith("sf_op="), { status: signup.status, created: signup.json.created, id: signup.json.operator?.id });
    cookies.push(signup.cookie); ids.push(signup.json.operator?.id);
  }
  const again = await http("/api/auth/signin", { method: "POST", body: JSON.stringify({ name: names[0].toLowerCase(), pin: pins[0] }) });
  check("sign in again (case-insensitive name) returns same id, created=false", again.status === 200 && again.json.created === false && again.json.operator.id === ids[0], again.json);
  const bad = await http("/api/auth/signin", { method: "POST", body: JSON.stringify({ name: names[1], pin: "0000" }) });
  check("bad PIN -> 401 with attemptsLeft 4", bad.status === 401 && bad.json.attemptsLeft === 4, bad.json);
  const malformed = await http("/api/auth/signin", { method: "POST", body: JSON.stringify({ name: names[1], pin: "12" }) });
  check("malformed PIN -> 400", malformed.status === 400, malformed.json);
  let last: any = null;
  for (let i = 0; i < 4; i++) last = await http("/api/auth/signin", { method: "POST", body: JSON.stringify({ name: names[1], pin: "0000" }) });
  check("5th bad PIN -> 429 locked", last.status === 429 && last.json.retryAfter === 300, last.json);
  const lockedGood = await http("/api/auth/signin", { method: "POST", body: JSON.stringify({ name: names[1], pin: pins[1] }) });
  check("correct PIN while locked -> 429", lockedGood.status === 429, lockedGood.json);
  const me = await http("/api/auth/me", { cookie: cookies[0] });
  check("me with cookie", me.status === 200 && me.json.operator.id === ids[0] && me.json.operator.name === names[0] && me.json.operator.role === "trainee", me.json);
  const anon = await http("/api/auth/me");
  check("me without cookie -> 401", anon.status === 401);
  const forged = await http("/api/auth/me", { cookie: cookies[0].replace(/.$/, (c) => (c === "A" ? "B" : "A")) });
  check("tampered cookie -> 401", forged.status === 401);
  const out = await http("/api/auth/signout", { method: "POST", cookie: cookies[0] });
  check("signout clears cookie", out.status === 200 && out.cookie === "sf_op=");
  const peopleDenied = await http("/api/forge/analytics/people", { cookie: cookies[0] });
  check("people list denied for trainee", peopleDenied.status === 401);
  let adminCookie = "";
  if (process.env.ADMIN_NAME) {
    const admin = await http("/api/auth/signin", { method: "POST", body: JSON.stringify({ name: process.env.ADMIN_NAME, pin: "9090" }) });
    adminCookie = admin.cookie;
    check("ADMIN_NAME operator gets admin role", admin.status === 200 && admin.json.operator.role === "admin", admin.json);
    const viaCookie = await http("/api/forge/analytics/people", { cookie: adminCookie });
    check("people list via admin cookie", viaCookie.status === 200 && Array.isArray(viaCookie.json.people), { status: viaCookie.status, n: viaCookie.json.people?.length });
  }

  // ---- events: 6 operators x 3 sessions on v1 ----
  // s2-sun: orientation mistake in 12/18 runs (passes threshold); s3-carrier: position in ~4/18 (does not); operator 3: wrong tool.
  let clock = Date.now() - 3 * 3600 * 1000;
  const sessions: string[] = [];
  for (let j = 0; j < 3; j++) for (let i = 0; i < 6; i++) {
    const run = session({ operatorId: "spoofed-ignored", version: 1, start: clock, mode: ["3d", "ar-train", "ar-assist"][j],
      mistakes: (step) => step === "s2-sun" && (i + j) % 3 !== 0 ? [{ reason: "orientation", partId: "sun-gear" }] : step === "s3-carrier" && (i * 3 + j) % 5 === 0 ? [{ reason: "position", partId: "carrier" }] : step === "s6-torque" && i === 2 ? [{ reason: "wrong-tool" }] : [],
      slow: (step) => step === "s2-sun" && (i + j) % 3 !== 0 ? 25000 : 0 });
    clock = run.end + 60000;
    const posted = await http("/api/events", { method: "POST", cookie: cookies[i], body: JSON.stringify({ events: run.events }) });
    if (posted.status !== 200 || posted.json.forge?.count !== run.events.length) check(`post session ${i}/${j}`, false, posted.json);
    sessions.push(run.sessionId);
  }
  check("18 sessions posted (verified via cookie)", sessions.length === 18);
  // in-progress session for operator 5, current step started 60 s ago -> hesitation
  const live = session({ operatorId: ids[5], version: 1, start: Date.now() - 120000, complete: false, mistakes: (step) => step === "s2-sun" ? [{ reason: "orientation" }] : [] });
  const lastStart = live.events.at(-1)!; lastStart.at = new Date(Date.now() - 60000).toISOString();
  const livePost = await http("/api/events", { method: "POST", cookie: cookies[5], body: JSON.stringify({ events: live.events }) });
  check("in-progress session posted", livePost.status === 200, livePost.json);
  // unverified + invalid
  const unverifiedSession = randomUUID();
  const unv = await http("/api/events", { method: "POST", body: JSON.stringify({ events: [
    { type: "forge_session_started", scenarioId: SCENARIO, scenarioVersion: 1, sessionId: unverifiedSession, sequence: 1, operatorId: "device-anon-1", mode: "3d", at: new Date().toISOString() },
    { type: "forge_mistake", scenarioId: SCENARIO, scenarioVersion: 1, sessionId: unverifiedSession, sequence: 2, operatorId: "device-anon-1", mode: "3d", reason: "made-up-reason", stepId: "s1-ring" },
    { type: "forge_mistake", scenarioId: "Bad Slug!", scenarioVersion: 1, sessionId: unverifiedSession, sequence: 3, mode: "3d" },
  ] }) });
  check("unverified event accepted, 2 invalid dropped", unv.status === 200 && unv.json.count === 1 && unv.json.dropped === 2 && unv.json.forge.verified === false, unv.json);
  const legacy = await http("/api/events", { method: "POST", body: JSON.stringify({ events: [{ type: "not_a_type", scenario: "tray" }] }) });
  check("legacy validation unchanged (unknown legacy type dropped)", legacy.status === 200 && legacy.json.dropped === 1, legacy.json);

  // ---- ClickHouse ----
  const ch = clickhouse()!;
  const rows = await (await ch.query({ query: "SELECT count() AS n, uniqExact(session_id) AS s, countIf(event_type = 'forge_session_completed') AS done, countIf(source = 'forge-unverified') AS unv, any(dag_version) AS v FROM spatial_events WHERE scenario_id = {s:String}", query_params: { s: `forge:${SCENARIO}` }, format: "JSONEachRow" })).json<any>();
  check("ClickHouse rows stored with scenario_id forge:<id>", Number(rows[0].n) > 300 && Number(rows[0].s) === 20 && Number(rows[0].done) === 18 && Number(rows[0].unv) === 1 && rows[0].v === "1", rows[0]);
  const sample = await (await ch.query({ query: "SELECT part_id, target_id, operator_code, payload FROM spatial_events WHERE scenario_id = {s:String} AND event_type = 'forge_mistake' AND target_id = 's2-sun' AND operator_code = {op:String} LIMIT 1", query_params: { s: `forge:${SCENARIO}`, op: ids[0] }, format: "JSONEachRow" })).json<any>();
  check("row: part_id, target_id=stepId, operator from cookie (not body)", sample[0]?.part_id === "sun-gear" && sample[0]?.target_id === "s2-sun" && ids.includes(sample[0]?.operator_code) && JSON.parse(sample[0].payload).operatorVerified === true, sample[0]);

  // ---- Valkey short-term ----
  const cache = valkey()!;
  const stmRaw = await cache.get(`sf:forge:stm:${ids[5]}:${SCENARIO}`);
  const stm = stmRaw ? JSON.parse(stmRaw) : null;
  const ttl = await cache.ttl(`sf:forge:stm:${ids[5]}:${SCENARIO}`);
  check("Valkey STM: current step, mistakes this session, last 20 events, TTL 24h", stm?.currentStepId === "s4-cover" && stm?.mistakes?.["s2-sun"]?.orientation === 1 && stm?.lastEvents?.length === 20 && ttl > 86000, { current: stm?.currentStepId, mistakes: stm?.mistakes, n: stm?.lastEvents?.length, ttl });
  const drill = await http(`/api/forge/analytics/operator?operatorId=${ids[5]}`, { headers: { authorization: `Bearer ${ADMIN}` } });
  const live5 = drill.json.shortTerm?.find((item: any) => item.scenarioId === SCENARIO);
  check("drill-down: hesitation flag (>45 s on step) and long-term profile", drill.status === 200 && live5?.hesitating === true && live5.timeOnStepMs > 45000 && drill.json.profiles?.some((p: any) => p.scenarioId === SCENARIO && p.runs === 3), { status: drill.status, hesitating: live5?.hesitating, t: live5?.timeOnStepMs, profiles: drill.json.profiles?.map((p: any) => [p.scenarioId, p.runs]) });

  // ---- PostgreSQL long-term ----
  const pg = postgres()!;
  const profiles = await pg.query("select operator_code, mistakes from operator_profiles where scenario_id = $1 order by operator_code", [`forge:${SCENARIO}`]);
  const p0 = profiles.rows.find((row) => row.operator_code === ids[1])?.mistakes;
  check("operator_profiles: 6 rows, runs=3 each, mistakes by step+reason, avg step time", profiles.rowCount === 6 && profiles.rows.every((row) => row.mistakes.runs === 3) && p0?.mistakes?.["s2-sun"]?.orientation >= 1 && p0?.avgStepMs?.["s1-ring"] > 0, { rows: profiles.rowCount, sample: { runs: p0?.runs, mistakes: p0?.mistakes, avg: p0?.avgStepMs } });
  const resend = await http("/api/events", { method: "POST", cookie: cookies[0], body: JSON.stringify({ events: [{ type: "forge_session_completed", scenarioId: SCENARIO, scenarioVersion: 1, sessionId: sessions[0], sequence: 99, mode: "3d" }] }) });
  const after = await pg.query("select mistakes from operator_profiles where operator_code = $1 and scenario_id = $2", [ids[0], `forge:${SCENARIO}`]);
  check("re-sent completion does not double count", resend.json.forge?.completed === 0 && after.rows[0].mistakes.runs === 3, { completed: resend.json.forge?.completed, runs: after.rows[0].mistakes.runs });

  // ---- analytics ----
  const analytics = await http(`/api/forge/analytics?scenarioId=${SCENARIO}`);
  const sun = analytics.json.steps?.find((s: any) => s.stepId === "s2-sun");
  check("analytics: per-step attempts, reasons, rate, median, top struggling", analytics.status === 200 && analytics.json.source === "clickhouse" && sun?.attempts >= 18 && sun?.byReason?.orientation >= 12 && sun?.mistakeRate > 0.6 && sun?.medianMs > 0 && analytics.json.topStruggling[0]?.stepId === "s2-sun", { totals: analytics.json.totals, sun, top: analytics.json.topStruggling?.map((s: any) => [s.stepId, s.mistakeRate]) });
  const list = await http("/api/forge/analytics");
  check("analytics scenario list includes fixture", list.json.scenarios?.some((s: any) => s.id === SCENARIO && s.runs === 18), list.json.scenarios?.find((s: any) => s.id === SCENARIO));

  // ---- coach ----
  const rules = await http(`/api/forge/coach?scenarioId=${SCENARIO}&llm=0`, { cookie: cookies[1] });
  check("coach (deterministic fallback)", rules.status === 200 && rules.json.source === "rules" && rules.json.focusSteps.includes("s2-sun") && rules.json.hints["s2-sun"], rules.json);
  const llm = await http(`/api/forge/coach?scenarioId=${SCENARIO}&fresh=1`, { cookie: cookies[1] });
  check("coach (LLM via FAST_MODEL)", llm.status === 200 && llm.json.source === "llm" && llm.json.briefing.length > 20, llm.json);
  const cached = await http(`/api/forge/coach?scenarioId=${SCENARIO}`, { cookie: cookies[1] });
  check("coach cached in Valkey", cached.json.cached === true && cached.json.briefing === llm.json.briefing, { cached: cached.json.cached });
  const other = await http(`/api/forge/coach?scenarioId=${SCENARIO}&operatorId=${ids[2]}&llm=0`, { cookie: cookies[1] });
  check("trainee cannot read another operator's coach (falls back to self)", other.json.operatorId === ids[1], { operatorId: other.json.operatorId });

  // ---- critic ----
  await sleep(4000); // after() critic runs triggered by the completions
  let proposals = await http(`/api/agent/proposals?scenario=forge:${SCENARIO}`);
  if (!proposals.json.proposals?.length) {
    const run = await http("/api/agent/critic", { method: "POST", headers: { authorization: `Bearer ${ADMIN}` }, body: JSON.stringify({ scenarioId: SCENARIO }) });
    console.log("critic ad hoc:", JSON.stringify(run.json).slice(0, 400));
    proposals = await http(`/api/agent/proposals?scenario=forge:${SCENARIO}`);
  }
  const proposal = proposals.json.proposals?.find((p: any) => p.step_id === "s2-sun" && p.status === "pending");
  check("critic proposal for s2-sun (auto after session completion), none for s3-carrier", Boolean(proposal) && !proposals.json.proposals.some((p: any) => p.step_id === "s3-carrier"), proposal ? { source: proposal.source, kind: proposal.kind, guidance: proposal.guidance, evidence: proposal.evidence?.pattern, rationale: proposal.rationale.slice(0, 300) } : proposals.json);
  const again2 = await http("/api/agent/critic", { method: "POST", headers: { authorization: `Bearer ${ADMIN}` }, body: JSON.stringify({ scenarioId: SCENARIO }) });
  check("critic does not duplicate a proposal", again2.json.results?.[0]?.proposals?.length === 0, again2.json.results?.[0]?.proposalSkipped);
  const deny = await http(`/api/agent/proposals/${proposal?.id}`, { method: "POST", cookie: cookies[0], body: JSON.stringify({ action: "approve" }) });
  check("approval denied for trainee", deny.status === 401);
  const approve = await http(`/api/agent/proposals/${proposal?.id}`, { method: "POST", ...(adminCookie ? { cookie: adminCookie } : { headers: { authorization: `Bearer ${ADMIN}` } }), body: JSON.stringify({ action: "approve" }) });
  const v2 = await getScenario(SCENARIO, { publishedOnly: true });
  const step = v2?.steps.find((s) => s.id === "s2-sun");
  check("approval publishes v2 with improved step text", approve.status === 200 && approve.json.version === 2 && v2?.version === 2 && v2.status === "published" && step?.hints?.[0] === proposal?.guidance.steps["s2-sun"].hint && step?.voiceLine === proposal?.guidance.steps["s2-sun"].voiceLine, { approve: approve.json, v2: { version: v2?.version, step } });
  const twice = await http(`/api/agent/proposals/${proposal?.id}`, { method: "POST", headers: { authorization: `Bearer ${ADMIN}` }, body: JSON.stringify({ action: "approve" }) });
  check("second approval -> 409", twice.status === 409, twice.json);

  // ---- v2 sessions, version comparison ----
  for (let i = 0; i < 6; i++) {
    const run = session({ operatorId: ids[i], version: 2, start: clock, mistakes: (s) => s === "s2-sun" && i === 0 ? [{ reason: "orientation" }] : [] });
    clock = run.end + 60000;
    await http("/api/events", { method: "POST", cookie: cookies[i], body: JSON.stringify({ events: run.events }) });
  }
  const compare = await http(`/api/forge/analytics?scenarioId=${SCENARIO}`);
  const byVersion = compare.json.versions?.map((v: any) => ({ version: v.version, runs: v.runs, sun: v.steps.find((s: any) => s.stepId === "s2-sun")?.mistakeRate }));
  check("per-version comparison shows v2 improvement on s2-sun", compare.json.version === "2" && byVersion?.length === 2 && byVersion[1].sun < byVersion[0].sun, byVersion);
  const coach2 = await http(`/api/forge/coach?scenarioId=${SCENARIO}&llm=0`, { cookie: cookies[1] });
  check("coach uses v2 after approval", coach2.json.version === 2, { version: coach2.json.version, briefing: coach2.json.briefing });
  console.log(`\n${failures ? `${failures} FAILED` : "ALL PASSED"} (scenario ${SCENARIO}, operators ${ids.join(", ")})`);
  await pg.end(); cache.disconnect(); await ch.close();
  process.exit(failures ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(1); });
