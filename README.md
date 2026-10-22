# SpatialForge AI

SpatialForge is a browser-based spatial assembly trainer: a Three.js workbench and camera hand tracking guide a technician through a valve assembly, every grab and correction streams to a data platform, and two agents use that data to improve the instructions. An admin approves each change, and the analytics show error rates by instruction version.

## Architecture

```
 Browser (Next.js / React, Three.js, MediaPipe hands, speech)
   │  events, sessions, passports            ▲ briefing + active guidance
   ▼                                          │
 Aiven Runtime: Next.js standalone server (Dockerfile)
   ├── /api/events ──────────────► Aiven ClickHouse   spatial_events (append-only, per dag_version)
   ├── /api/sessions, /passports ► Aiven PostgreSQL   sessions, passports, dag_versions, operator_profiles, agent_proposals
   ├── PATCH /api/sessions ──────► Aiven Valkey       critic job queue, live session state, coach cache, rate limits
   │
   ├── Critic agent  /api/agent/critic   queue job → fixed ClickHouse query tools → operator profile + proposal
   ├── Admin review  /admin              approve → new dag_versions row (1.0 → 1.1), Coach caches invalidated
   └── Coach agent   /api/agent/coach    active guidance + operator profile → briefing and step hints (cached)
```

Placement correctness is deterministic (`src/lib/spatial-engine.ts`, `src/lib/assembly.ts`); agents never decide whether a part is placed correctly. They can only change guidance text (`preWarning`, `hint`, `voiceLine`, `substeps`), and nothing goes live without admin approval.

## Run locally

```powershell
npm.cmd install
npm.cmd run dev
```

Open `http://localhost:3000`. With no environment variables the app runs fully in the browser: runs are stored in localStorage, voice uses browser speech, and the built-in instructions (v1.0) are used.

- **Precision tray:** four shapes, any order. Each shape is accepted only by its matching target.
- **Small valve assembly:** O-ring, spool, gland nut, and actuator cap are all pickable, but placement needs the matching target, the prerequisite chain, and the required rotation.
- **Pneumatic control valve:** eight parts with a protected core sequence.

The workbench supports mouse and touch: select a part, rotate it if needed, and release it over its target. Camera AR uses the same rules with a pinch gesture. Wrong targets, missing prerequisites, and wrong rotations turn the target amber and the co-pilot gives a spoken and captioned correction.

## Data services and agents

1. Copy `.env.example` to `.env.local` and fill in the Aiven service URIs (`DATABASE_URL`, `CLICKHOUSE_URL`/`CLICKHOUSE_USER`/`CLICKHOUSE_PASSWORD`, `VALKEY_URL`), the project CA (`AIVEN_CA_CERT`, PEM text or a path to `ca.pem`), an `ADMIN_TOKEN`, and optionally `OPENROUTER_API_KEY` and ElevenLabs. For local stand-ins, `docker compose up -d` starts PostgreSQL, ClickHouse, and Valkey on ports 55432, 58123, and 56379 (URLs are in `.env.example`).
2. `npm run db:migrate` applies `db/postgres.sql` and `db/clickhouse.sql` (idempotent).
3. `npm run db:seed` writes 30 simulated runs across 10 operators with realistic habits (six operators tend to grab the gland nut before the spool, four fit the cap at the wrong rotation), so the Critic has history to learn from.
4. `GET /api/health` reports each service as `ok`, `down`, or `unconfigured`.

**Critic** (`POST /api/agent/critic`, admin token). Completing a run (`PATCH /api/sessions`) queues a job in Valkey. The Critic pops it and runs fixed, parameterized ClickHouse tools: `operatorMistakes`, `stepErrorRates`, `commonWrongOrder`, `hesitationByStep`, and `versionComparison`. The model chooses which extra tools to call but never writes SQL. The Critic updates the operator's profile in PostgreSQL. When a pattern reaches at least 30% of completed runs and at least 5 runs on the active version, it writes an `agent_proposals` row with the evidence numbers and a guidance change. With `OPENROUTER_API_KEY` set, the pinned model `z-ai/glm-5.3-flash` (no provider fallbacks) writes the rationale and text, and its JSON is validated with zod. Without a key, or when the output is invalid, deterministic rules write the proposal from the same numbers. Each proposal is marked `llm` or `rules`.

**Admin review** (`/admin`). Enter the `ADMIN_TOKEN` (kept in sessionStorage; the server checks it). From there you can **Run critic**, read each proposal's rationale, evidence, and current-versus-proposed diff, and approve or reject it. Approving creates the next instruction version, makes it the scenario's single active version, and clears the Coach caches in Valkey. The **Version impact** chart shows, for each step, the share of runs with a correction under each version.

**Coach** (`GET /api/agent/coach?operator=7&scenario=valve`). At session start the training page loads the active guidance (`GET /api/guidance`, no LLM, so the run's version never waits on the model) and then a short personal briefing, for example: "Last time you picked the Gland nut before the Spool. The Spool goes in first." It speaks and captions the briefing, uses the version's hints and pre-warnings in place of the built-in text, and stamps every event with that `dagVersion`. Briefings are cached in Valkey per operator, scenario, and version. Without data or an LLM it falls back to rules or the default text.

### Demo flow

1. Migrate and seed, then open `/admin`, choose **Small valve assembly**, enter the admin token, and press **Run critic**. A proposal appears, for example: "12 of 25 valve runs (48%) on v1.0 picked the Gland nut before fitting the Spool…"
2. Approve it. The version changes to v1.1.
3. On `/`, choose operator 1 and the valve scenario. The briefing now includes the v1.1 pre-warning, and the spool step shows it.
4. Complete runs. The version impact chart shows separate bars for v1.0 and v1.1.

## Try Camera AR on iPhone

Safari needs HTTPS for camera access, either through the deployed Aiven Runtime URL or through an HTTPS tunnel to `npm.cmd run dev`. Choose **Camera AR**, keep one hand visible, pinch a shape in the parts dock, move it to its target, and open your fingers to release. If gesture tracking is difficult, tap a part in the list and then tap its target. Camera frames and hand landmarks stay in the browser. The camera view is a screen-locked overlay, not room-anchored AR, and it does not inspect physical parts.

## Deployment and limitations

`DEPLOY.md` covers the container build (`output: "standalone"`, multi-stage Node 22 `Dockerfile`) and the secrets to set in the Runtime. The deployment steps have not been verified against Aiven Runtime from this repository; confirm them against Aiven's current documentation. The admin token is one shared secret (demo-grade). Operator identity is a self-declared digit. Physical-part inspection, PDF-to-spatial compilation, and room anchoring are future work.
