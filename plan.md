# SpatialForge AI — Hackathon Plan (Aiven + Data-Driven Agent)

The original pilot plan is kept at `docs/pilot-plan.md`. This plan covers the work needed to meet the hackathon brief: **agents that depend on data to deliver value**, **deployed on Aiven's Runtime**, using **Aiven managed data services**.

## Goal

A technician trains on the guided valve assembly. Every grab, correction, and placement streams into Aiven. After each run, a **Critic agent** reads that operator's history and cross-operator patterns, then proposes better instructions. An admin approves them. The next run is coached differently, and the analytics show error rates dropping by instruction version.

Demo line: *"Run 1 the operator fits the gland nut before the spool. The agent sees 6 of 10 operators make the same mistake, proposes a pre-warning, the admin approves it, and run 2 starts with that warning. The error rate for that step falls in the version chart."*

## Ground rules (unchanged from the pilot)

- Placement correctness stays deterministic (`spatial-engine.ts`, `assembly.ts`). The agent never decides whether a part was placed correctly.
- The agent can only change *guidance* (hints, warnings, substep prompts, voice lines). It cannot change targets, rotations, or prerequisites.
- No proposal goes live without admin approval.
- The app must still work with no keys set (local storage + browser speech), so the demo survives network failures.

---

## Phase 1 — Move the data layer to Aiven

Replace Supabase with three Aiven services, each with a clear job:

| Service | Holds | Why this one |
|---|---|---|
| **Aiven PostgreSQL** | sessions, operators, completion passports, instruction versions (`dag_versions`), agent proposals, operator profiles | Relational records that need constraints and an approval workflow |
| **Aiven ClickHouse** | every `spatial_event` (append-only) | Fast aggregate queries across all runs; this is what the agent queries |
| **Aiven Valkey** | live session state, Critic job queue, per-operator coaching cache, rate limits | Low-latency state, and a queue so the Critic runs after a session without blocking the request |

### Tasks

1. Provision PostgreSQL, ClickHouse, and Valkey in one Aiven project and region. Record connection URIs in `.env.local` only.
2. Add dependencies: `pg`, `@clickhouse/client`, `iovalkey` (or `ioredis`). Remove `@supabase/supabase-js` once all routes are moved.
3. Create `src/lib/db/`:
   - `postgres.ts`: a shared `pg` pool using Aiven's CA certificate (`sslmode=verify-full`).
   - `clickhouse.ts`: a shared ClickHouse client.
   - `valkey.ts`: a shared Valkey client.
   - Each returns `null` when its env var is missing, matching the current "persisted: false" fallback.
4. Rewrite the schema as `db/postgres.sql` and `db/clickhouse.sql`:
   - Drop the Supabase-only `auth.users` reference and RLS policies. Admin access becomes a server-checked `ADMIN_TOKEN` (enough for the demo; note it as a limitation).
   - New PostgreSQL tables: `operator_profiles` (operator_code, scenario_id, mistake summary JSON, updated_at) and `agent_proposals` (id, scenario_id, based_on_version, rationale, evidence query results, proposed guidance JSON, status, reviewed_at).
   - `dag_versions` gains `scenario_id`, `guidance jsonb`, and an `is_active` flag (one active per scenario).
   - ClickHouse `spatial_events`: `MergeTree` ordered by `(scenario_id, operator_code, session_id, sequence)`, with a `dag_version` column so error rates can be grouped by instruction version.
5. Add `scripts/migrate.ts` to apply both schema files, and `scripts/seed.ts` to generate about 30 simulated runs across 10 operators with realistic mistake patterns. Without seeding, the agent has nothing to learn from during a live demo.
6. Port the routes:
   - `/api/events` → batch insert into ClickHouse and update the live session in Valkey.
   - `/api/sessions` → PostgreSQL. Add `PATCH` to mark a session complete, which pushes a Critic job to Valkey.
   - `/api/passports` → PostgreSQL. Keep the existing hash and manifest validation as-is.
7. Add `/api/health`, which reports the reachability of each service. Use it for deployment checks and the admin page.

**Done when:** a run on localhost writes events to ClickHouse and sessions and passports to PostgreSQL, the admin page lists cloud sessions from PostgreSQL, and the app still works with every Aiven variable removed.

---

## Phase 2 — Deploy on Aiven Runtime

1. Set `output: "standalone"` in `next.config` and add a `Dockerfile` (Node 22, multi-stage build).
2. Follow Aiven's current Runtime documentation for the deployment method, build settings, and secrets. Verify these against the docs at deploy time rather than assuming them.
3. Put every secret in the Runtime's secret store. None go in the repo.
4. Confirm the deployed URL is HTTPS, so iPhone camera access works without the Cloudflare tunnel.
5. Run a smoke test on the deployed URL: `/api/health` is green, a desktop run completes, an iPhone Camera AR run completes, and the events show up in ClickHouse.

**Done when:** a public HTTPS URL on Aiven runs the full flow against Aiven data services.

---

## Phase 3 — The data-driven agent loop

Two agents and one human gate. Both agents use the existing OpenRouter key and pinned model through a shared `src/lib/agent/llm.ts`. Their outputs are JSON validated with `zod`; invalid output is discarded, never applied.

### 3a. Critic agent (after each run, from the Valkey queue)

- **Trigger:** session marked complete → job pushed to Valkey → processed by a worker (`/api/agent/critic`, invoked from the queue or by the admin's "Run critic" button for the demo).
- **Data tools:** a fixed set of parameterized ClickHouse queries. The model chooses which tools to call but never writes SQL.
  - `operatorMistakes(operator, scenario)`: this operator's corrections by step and kind.
  - `stepErrorRates(scenario, dagVersion)`: corrections per step, per run, for every operator.
  - `commonWrongOrder(scenario)`: the most frequent out-of-order attempts.
  - `hesitationByStep(scenario)`: median time from grab to correct placement.
  - `versionComparison(scenario)`: error rate per instruction version.
- **Output:**
  1. Updates `operator_profiles` (long-term memory for that operator).
  2. When a cross-operator pattern passes a threshold (for example, at least 30% of runs and at least 5 runs), writes an `agent_proposals` row. The row includes the evidence numbers it used and a guidance change limited to the allowed fields: `preWarning`, `hint`, `voiceLine`, `substeps`.

### 3b. Coach agent (at session start)

- Reads the active `dag_versions.guidance` for the scenario plus the operator's `operator_profiles`.
- Produces a short personalised briefing and per-step hint overrides, for example: *"Last time you fitted the gland nut before the spool. Spool goes in first."*
- Cached in Valkey per operator + version, so repeat starts are instant and cost nothing.
- Falls back to the default guidance when the LLM or data is unavailable.

### 3c. Admin review

- The `/admin` page gets a **Proposals** section showing the rationale, the evidence numbers, and a diff of current versus proposed guidance, with Approve and Reject buttons.
- Approving creates a new `dag_versions` row (for example 1.0 → 1.1), marks it active, and invalidates Coach caches in Valkey.
- A **Version impact** chart shows error rate per step for each version, queried from ClickHouse. This is the visible proof that the system improves.

### 3d. Wiring into the training UI

- `page.tsx` loads the active guidance and the Coach briefing when a session starts. It speaks and captions the briefing and uses step hints and pre-warnings in place of hard-coded text, falling back to the current text.
- Every event carries `dagVersion` so impact can be measured.

**Done when:** after seeding, completing a valve run with a known mistake produces a proposal citing real numbers. Approving it changes the next session's briefing and warnings. The version chart shows separate bars for 1.0 and 1.1.

---

## Phase 4 — Clean up unused AI surface

- Remove `/api/inspect` and the `OPENROUTER` image-inspection path from the README, or move them into `docs/` as future work. Judges should only see features that work. Physical-part inspection stays deferred.
- Update `README.md`: architecture diagram (browser → Aiven Runtime → PostgreSQL / ClickHouse / Valkey → agents), setup for Aiven, and how to run the migrate and seed scripts.
- Update `.env.example` with the new variable names: `DATABASE_URL`, `CLICKHOUSE_URL`, `CLICKHOUSE_USER`, `CLICKHOUSE_PASSWORD`, `VALKEY_URL`, `AIVEN_CA_CERT`, `ADMIN_TOKEN`, `OPENROUTER_API_KEY`, `ELEVENLABS_*`. Remove the Supabase, n8n, and 8th Wall variables that are no longer used.

---

## Deferred (later)

- **Route to first users:** target customer, pilot offer, success metrics.
- **Data-centred demo story and pitch:** scripted before/after run with the version-impact chart.
- PDF-to-spatial compiler, room-anchored AR, physical-part inspection, n8n inventory webhook, open-palm whole-object rotation gesture.

---

## Order of work

1. Phase 1, steps 1–5 (services, clients, schema, seed) — foundation for everything else
2. Phase 1, steps 6–7 (route ports, health)
3. Phase 2 (deploy early, so deployment problems surface while there is time)
4. Phase 3a Critic → 3c Admin review → 3b Coach → 3d UI wiring
5. Phase 4 cleanup and README
6. Redeploy and run the full smoke test

## Risks

| Risk | Mitigation |
|---|---|
| Aiven Runtime build/deploy differs from expectations | Deploy a minimal build in step 3 of the order, before the agent work |
| Too little real data for the Critic to find patterns | The seed script generates realistic multi-operator history |
| LLM returns malformed or out-of-scope changes | zod validation plus an allow-list of guidance fields; failures are logged and skipped |
| LLM latency at session start | Valkey cache plus a default-guidance fallback; the briefing loads asynchronously |
| Network or service failure during the live demo | Existing local-storage and browser-speech fallbacks stay in place |
| Simple admin token is weak | Acceptable for the demo; document it as a known limitation |
