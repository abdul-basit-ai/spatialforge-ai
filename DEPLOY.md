# Deploying SpatialForge AI

The app builds to a self-contained Next.js server (`output: "standalone"`) inside a multi-stage Node 22 image (`Dockerfile`). These are generic container steps. **Aiven Runtime specifics (build method, port, secret store, health check settings) have not been verified here; confirm each step against Aiven's current Runtime documentation before deploying.**

## 1. Data services

1. Create Aiven PostgreSQL, ClickHouse, and Valkey services in one project and region.
2. Download the project CA certificate (`ca.pem`).
3. From a machine with the repo, put the service URIs in `.env.local` (never commit it) and run:
   ```sh
   npm ci
   npm run db:migrate   # applies db/postgres.sql and db/clickhouse.sql
   npm run db:seed      # optional: 30 simulated runs so the Critic has history
   ```

## 2. Environment / secrets

Set these in the platform's secret store, not in the image or repo:

| Variable | Value |
|---|---|
| `DATABASE_URL` | PostgreSQL service URI |
| `CLICKHOUSE_URL` | ClickHouse **HTTPS** endpoint, e.g. `https://host:port` |
| `CLICKHOUSE_USER`, `CLICKHOUSE_PASSWORD` | ClickHouse credentials |
| `CLICKHOUSE_DATABASE` | optional, defaults to `default` |
| `VALKEY_URL` | Valkey URI (`rediss://...`) |
| `AIVEN_CA_CERT` | contents of `ca.pem` (literal `\n` is accepted) or a path to it inside the container |
| `ADMIN_TOKEN`, `OPENROUTER_API_KEY`, `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID` | as needed |

With `AIVEN_CA_CERT` set, PostgreSQL uses verified TLS (equivalent to `sslmode=verify-full`; any `sslmode` in the URI is replaced), and ClickHouse (https) and Valkey (rediss) trust the Aiven CA in addition to public roots. Any unset service falls back to `persisted: false`.

## 3. Build and run the image

```sh
docker build -t spatialforge-ai .
docker run --rm -p 3000:3000 --env-file .env.production spatialforge-ai
```

The container listens on `PORT` (default 3000) on `0.0.0.0` and runs as a non-root user. Its built-in `HEALTHCHECK` calls `GET /api/health`, which returns 200 when every configured service is reachable and 503 when one is down.

## 4. Smoke test the deployed URL

- The URL must be HTTPS (iPhone camera access requires a secure context).
- `GET /api/health` returns `"ok": true` with each service `"ok"`.
- Complete a desktop run and an iPhone Camera AR run, then check rows in `assembly_sessions` / `completion_passports` (PostgreSQL), `spatial_events` (ClickHouse), and a job on the `sf:critic:jobs` list (Valkey).
