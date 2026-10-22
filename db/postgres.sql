-- SpatialForge relational records (Aiven PostgreSQL). Idempotent; applied by `npm run db:migrate`.
-- Admin access is a server-checked ADMIN_TOKEN (demo limitation); there are no RLS policies or auth.users references.

create table if not exists assembly_sessions (
  id uuid primary key,
  operator_code text not null,
  scenario_id text not null,
  mode text not null default 'workbench',
  dag_version text not null default '1.0',
  capability_report jsonb not null default '{}'::jsonb,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  summary jsonb not null default '{}'::jsonb
);
create index if not exists assembly_sessions_operator_idx on assembly_sessions(operator_code, started_at desc);
create index if not exists assembly_sessions_started_idx on assembly_sessions(started_at desc);

-- Instruction versions. Only guidance (preWarning, hint, voiceLine, substeps per step) is versioned here;
-- targets, rotations, and prerequisites stay deterministic in src/lib/assembly.ts.
create table if not exists dag_versions (
  id uuid primary key default gen_random_uuid(),
  scenario_id text not null,
  version text not null,
  status text not null default 'proposed' check (status in ('proposed','approved','rejected')),
  guidance jsonb not null default '{"steps":{}}'::jsonb,
  proposal jsonb not null default '{}'::jsonb,
  is_active boolean not null default false,
  reviewed_by text,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (scenario_id, version)
);
create unique index if not exists dag_versions_one_active_idx on dag_versions(scenario_id) where is_active;

insert into dag_versions (scenario_id, version, status, is_active, reviewed_by, reviewed_at)
values ('tray','1.0','approved',true,'system',now()), ('valve','1.0','approved',true,'system',now()), ('pneumatic','1.0','approved',true,'system',now())
on conflict do nothing;

create table if not exists completion_passports (
  id uuid primary key default gen_random_uuid(),
  operator_code text not null,
  scenario_id text,
  session_id uuid,
  dag_version text not null,
  evidence jsonb not null,
  sha256 text not null unique,
  created_at timestamptz not null default now()
);
create index if not exists completion_passports_operator_idx on completion_passports(operator_code, created_at desc);

-- Long-term memory per operator, written by the Critic agent.
create table if not exists operator_profiles (
  operator_code text not null,
  scenario_id text not null,
  mistakes jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (operator_code, scenario_id)
);

-- Guidance changes proposed by the Critic; nothing goes live without admin approval.
create table if not exists agent_proposals (
  id uuid primary key default gen_random_uuid(),
  scenario_id text not null,
  based_on_version text not null,
  rationale text not null,
  evidence jsonb not null default '[]'::jsonb,
  guidance jsonb not null,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz
);
create index if not exists agent_proposals_status_idx on agent_proposals(scenario_id, status, created_at desc);
-- step_id/kind identify the pattern; source says whether the LLM or the deterministic rules wrote the text.
alter table agent_proposals add column if not exists step_id text not null default '';
alter table agent_proposals add column if not exists kind text not null default '';
alter table agent_proposals add column if not exists source text not null default 'rules';
alter table agent_proposals add column if not exists model text;
alter table agent_proposals add column if not exists session_id uuid;
alter table agent_proposals add column if not exists reviewed_by text;
alter table agent_proposals add column if not exists approved_version text;
do $$ begin
  alter table agent_proposals add constraint agent_proposals_source_check check (source in ('llm','rules'));
exception when duplicate_object then null; end $$;
-- One open proposal per pattern and instruction version.
create unique index if not exists agent_proposals_pending_idx on agent_proposals(scenario_id, based_on_version, step_id, kind) where status = 'pending';
