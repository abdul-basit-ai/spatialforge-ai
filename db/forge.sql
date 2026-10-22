-- Forge: imported/generated assembly scenarios, their assets and cached audio, and named operators. Idempotent.

create table if not exists forge_scenarios (
  id text not null,
  version integer not null,
  status text not null check (status in ('draft','published')),
  title text not null,
  data jsonb not null,
  created_by text,
  created_at timestamptz not null default now(),
  published_at timestamptz,
  primary key (id, version)
);
create index if not exists forge_scenarios_status_idx on forge_scenarios(status, created_at desc);

-- Uploaded source files and converted meshes (glTF binary). Kept small: the import route caps file size.
create table if not exists forge_assets (
  id uuid primary key default gen_random_uuid(),
  scenario_id text,
  name text not null,
  mime text not null,
  bytes bytea not null,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists forge_assets_scenario_idx on forge_assets(scenario_id);

-- ElevenLabs audio cache keyed by sha256(voiceId + model + text).
create table if not exists forge_audio (
  key text primary key,
  mime text not null default 'audio/mpeg',
  bytes bytea not null,
  text text not null,
  created_at timestamptz not null default now()
);

-- Named operators (name + PIN). operator_code in other tables holds operators.id.
create table if not exists operators (
  id text primary key,
  display_name text not null unique,
  pin_hash text not null,
  role text not null default 'trainee' check (role in ('trainee','admin')),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz
);
