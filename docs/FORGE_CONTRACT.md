# Forge build contract

Forge is the general assembly platform. A user uploads CAD files (STEP, IGES, STL, OBJ, glTF), PDF manuals or images, or just types a prompt ("train me on a planetary gearbox"). The system builds a playable scenario: parts, assembled poses, mates and steps. People train in 3D, in AR on a real table, or with AR assist over real hardware. ElevenLabs voices every step and every correction. Each person signs in with a name and PIN, and the system keeps short-term memory (Valkey), long-term memory (PostgreSQL) and group struggle analytics (ClickHouse).

Scope: mechanical and mechatronic work. Mechatronic parts such as motors, sensors, connectors and cables count as physical parts. Schematic-level electrical work is out of scope.

## Shared contract (do not change signatures; additive optional fields are OK)

| File | What |
|---|---|
| `src/lib/forge/types.ts` | Scenario format: `ForgeScenario`, `ForgePart`, `Mate`, `ForgeStep`, `ForgeEvent` |
| `src/lib/forge/engine.ts` | Deterministic engine: `createRun`, `nextSteps`, `attemptPlace`, `attemptStep`, `stagingPose`, `orientationError` |
| `src/lib/forge/validate.ts` | `validateScenario(s) -> string[]`; publishing is blocked while there are issues |
| `src/lib/forge/repo.ts` | PostgreSQL persistence: `saveScenario`, `getScenario`, `listScenarios`, `saveAsset`, `getAsset`, `attachAssets` (falls back to in-memory storage) |
| `src/lib/forge/samples/index.ts` | `BUILTIN_SCENARIOS`, `builtinScenario(id)` |
| `src/lib/forge/three-parts.ts` | `buildPartObject(part)`, `primitiveGeometry`, `loadAsset`, `applyTransform`, `readTransform` |
| `src/lib/forge/run-store.ts` | `useForgeRun` zustand store: `start`, `place`, `complete`, `reset`, `setMode` |
| `src/lib/forge/voice-client.ts` | `speak(text, {audioUrl})`, `stopSpeaking`, `setVoiceEnabled` |
| `src/lib/forge/voice-server.ts` | `synthesize(text)`, `generateScenarioAudio(scenario)` |
| `src/lib/forge/telemetry.ts` | `trackForge(event)` |
| `src/components/forge/ForgeScene.tsx` | Shared 3D scene (`ForgeSceneProps`) |
| `src/components/forge/ARModes.tsx` | `ARTrainer`, `ARAssist` (`ARModeProps`) |
| `src/lib/ai/openai.ts` | `aiJson(label, zodSchema, instructions, input, {model, webSearch})`; `MODEL` = gpt-5.5, `FAST_MODEL` = gpt-5.4-mini. This is the only OpenAI caller. |
| `db/forge.sql` | Tables `forge_scenarios`, `forge_assets`, `forge_audio`, `operators` (applied by `npm run db:migrate`) |

Stored scenario ids are slugs. In events and ClickHouse, Forge runs use `scenario_id = "forge:<id>"` and `dag_version = "<version>"`.

## Ownership (each agent edits only its own files, plus new files under its own folders)

| Agent | Owns |
|---|---|
| engine | `src/lib/forge/engine.ts`, `src/lib/forge/samples/**`, `tests/forge/**`, the `test` script in package.json |
| trainer | `src/components/forge/ForgeScene.tsx`, `src/lib/forge/three-parts.ts`, `src/lib/forge/run-store.ts`, `src/app/train/**`, `src/components/forge/trainer/**`, `src/app/layout.tsx`, `src/app/globals.css` (append only, `.forge-` prefix) |
| ar | `src/components/forge/ARModes.tsx`, `src/components/forge/ar/**`, `src/app/api/forge/verify-step/**` |
| import | `src/app/studio/page.tsx`, `src/lib/forge/import/**` (browser-side parsing), `src/app/api/forge/assets/**`, `public/occt/**` |
| compiler | `src/app/api/forge/compile/**`, `src/lib/forge/compiler/**` (server-side PDF/CAD/web/knowledge pipeline) |
| editor | `src/app/studio/[id]/**`, `src/components/forge/editor/**`, `src/app/api/forge/scenarios/**` (list/get/save/publish) |
| voice | `src/lib/forge/voice-server.ts`, `src/lib/forge/voice-client.ts`, `src/app/api/forge/tts/**`, `src/app/api/forge/audio/**`, `src/app/api/voice/route.ts` |
| people | `src/lib/auth.ts`, `src/app/signin/**`, `src/app/api/auth/**`, `src/app/api/events/route.ts`, `src/lib/forge/telemetry.ts`, `src/lib/forge/memory.ts`, `src/lib/agent/**`, `src/app/api/agent/**`, `src/app/api/forge/coach/**`, `src/app/api/forge/analytics/**`, `src/app/admin/**`, `src/components/AgentReview.tsx` |

The legacy tray/valve app (`src/app/page.tsx` and the files it uses) stays working. Forge lives under `/train`, `/studio` and `/signin`.
