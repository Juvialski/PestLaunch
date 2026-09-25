create table public.demo_customers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  customer_type text,
  pipeline_stage text,
  health_status text,
  assigned_to text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.calls (
  id uuid primary key default gen_random_uuid(),
  caller_name text,
  demo_customer_id uuid references public.demo_customers(id) on delete set null,
  audio_path text not null unique,
  original_filename text not null check (char_length(original_filename) between 1 and 255),
  mime_type text not null check (mime_type in ('audio/mpeg', 'audio/wav', 'audio/mp4', 'audio/webm')),
  status text not null default 'UPLOADED' check (
    status in ('UPLOADED', 'PROCESSING', 'TRANSCRIBED', 'ANALYZED', 'NEEDS_REVIEW', 'FAILED')
  ),
  duration integer check (duration is null or duration >= 0),
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index calls_created_at_desc_idx on public.calls (created_at desc);

create table public.transcripts (
  id uuid primary key default gen_random_uuid(),
  call_id uuid not null unique references public.calls(id) on delete cascade,
  text text not null,
  segments_json jsonb not null default '[]'::jsonb check (jsonb_typeof(segments_json) = 'array'),
  model_used text not null,
  attempt_count integer not null default 1 check (attempt_count > 0),
  created_at timestamptz not null default now()
);

create table public.call_analysis (
  id uuid primary key default gen_random_uuid(),
  call_id uuid not null unique references public.calls(id) on delete cascade,
  call_type text,
  confidence numeric(5, 4) check (confidence is null or confidence between 0 and 1),
  summary text,
  analysis_json jsonb not null default '{}'::jsonb,
  model_used text not null,
  created_at timestamptz not null default now()
);

create table public.agent_actions (
  id uuid primary key default gen_random_uuid(),
  call_id uuid not null references public.calls(id) on delete cascade,
  action_type text not null,
  payload_json jsonb not null default '{}'::jsonb,
  status text not null default 'PENDING' check (
    status in ('PENDING', 'APPROVED', 'REJECTED', 'EXECUTING', 'COMPLETED', 'FAILED')
  ),
  requires_approval boolean not null default true,
  error_message text,
  created_at timestamptz not null default now(),
  approved_at timestamptz,
  executed_at timestamptz
);

create function public.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at := pg_catalog.now();
  return new;
end;
$$;

revoke all on function public.set_updated_at() from public, anon, authenticated;
grant execute on function public.set_updated_at() to service_role;

create trigger demo_customers_set_updated_at
before update on public.demo_customers
for each row execute function public.set_updated_at();

create trigger calls_set_updated_at
before update on public.calls
for each row execute function public.set_updated_at();

alter table public.demo_customers enable row level security;
alter table public.calls enable row level security;
alter table public.transcripts enable row level security;
alter table public.call_analysis enable row level security;
alter table public.agent_actions enable row level security;

revoke all on table public.demo_customers, public.calls, public.transcripts,
  public.call_analysis, public.agent_actions from anon, authenticated;

grant usage on schema public to service_role;
grant select, insert, update, delete on table public.demo_customers, public.calls,
  public.transcripts, public.call_analysis, public.agent_actions to service_role;
