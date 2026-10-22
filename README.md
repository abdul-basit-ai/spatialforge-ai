# SpatialForge AI

SpatialForge is a browser based spatial assembly demo with a Three.js workbench, camera hand tracking, guided corrections, and scenario-specific run records.

## Run locally

```powershell
npm.cmd install
npm.cmd run dev
```

Open `http://localhost:3000`. Choose one of the two scenarios:

- **Precision tray:** four shapes can be placed in any order. Each shape is accepted only by its matching target.
- **Small valve assembly:** O-ring, spool, gland nut, and actuator cap are all visible and pickable. Placement is accepted only when the matching target, prerequisite chain, and required rotation are correct.

The 3D workbench supports mouse and touch. Select a part from the dock or the parts list, use the rotate buttons when needed, and release it over its target. Camera AR uses the same rules: pinch directly on a dock shape, move it to its target, and release. Hovering never completes a placement. When a part is wrong for a target or is blocked by a prerequisite, the target turns amber and the co-pilot gives a spoken and captioned correction.

## Try Camera AR on iPhone

1. Start the app with `npm.cmd run dev`.
2. Expose port 3000 through your HTTPS Cloudflare tunnel.
3. Open the tunnel's `https://...` URL in Safari and allow camera access.
4. Choose **Camera AR**. It expands to a phone-friendly view. Keep one hand visible and point the rear camera at a well-lit surface.
5. Pinch a visible shape in the parts dock. Move it to its matching target and open your fingers to release it.
6. If gesture tracking is difficult, tap a part in the list and tap its target. Rotation controls remain available in the side panel. Use **Voice on/off** to control automatic corrections and **Exit view** to leave the expanded camera mode.

Safari needs HTTPS for camera access. The camera image and hand landmarks stay in the browser. The current camera view is a screen-locked pass-through overlay, not room-anchored 8th Wall SLAM, and it does not inspect physical parts.

## Data and services

Runs are stored in localStorage per operator and scenario. The `/admin` page shows placement and correction events for the selected scenario. When the data services are configured, sessions and passports go to PostgreSQL, every spatial event goes to ClickHouse, and live session state plus the Critic job queue live in Valkey (Aiven in production). Passport validation uses the scenario manifest, required rotations, target IDs, and prerequisite order before persistence.

Copy `.env.example` to `.env.local` for the optional data services and ElevenLabs. Browser speech and local storage keep the demo usable with every variable unset (routes answer `persisted: false`). For local services run `docker compose up -d`, set the localhost URLs from `.env.example`, then `npm run db:migrate` (applies `db/postgres.sql` and `db/clickhouse.sql`) and `npm run db:seed` (30 simulated runs across 10 operators). `GET /api/health` reports reachability of each service. See `DEPLOY.md` for container deployment.

PDF scene compilation, room anchoring, physical-part computer vision verification, and autonomous DAG changes remain future phases.
