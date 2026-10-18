-- SpatialForge demo persistence. Run in the Supabase SQL editor.
create table if not exists spatial_events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null,
  operator_code text,
  scenario_id text,
  part_id text,
  target_id text,
  rotation integer,
  slot_id text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists dag_versions (
  id uuid primary key default gen_random_uuid(),
  version text not null unique,
  status text not null default 'proposed' check (status in ('proposed','approved','rejected')),
  proposal jsonb not null default '{}'::jsonb,
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists completion_passports (
  id uuid primary key default gen_random_uuid(),
  operator_code text not null,
  dag_version text not null,
  evidence jsonb not null,
  sha256 text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists assembly_sessions (
  id uuid primary key,
  operator_code text not null,
  scenario_id text not null,
  mode text not null,
  capability_report jsonb not null default '{}'::jsonb,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  summary jsonb not null default '{}'::jsonb
);

alter table spatial_events add column if not exists session_id uuid references assembly_sessions(id);
alter table spatial_events add column if not exists sequence integer;
alter table spatial_events add column if not exists mode text;
create index if not exists spatial_events_session_idx on spatial_events(session_id, sequence);
create index if not exists assembly_sessions_operator_idx on assembly_sessions(operator_code, started_at desc);

alter table spatial_events enable row level security;
alter table dag_versions enable row level security;
alter table completion_passports enable row level security;
alter table assembly_sessions enable row level security;

create index if not exists spatial_events_operator_idx on spatial_events(operator_code, created_at desc);
create index if not exists spatial_events_type_idx on spatial_events(event_type, created_at desc);

alter table spatial_events add column if not exists scenario_id text;
alter table spatial_events add column if not exists part_id text;
alter table spatial_events add column if not exists target_id text;
alter table spatial_events add column if not exists rotation integer;
