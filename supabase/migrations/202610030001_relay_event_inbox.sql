-- Relay requires a durable commit before acknowledging delivery. This is transport
-- bookkeeping; wardrobe/profile/conversation schemas belong to later milestones.
create table public.relay_event_inbox (
  event_id uuid primary key,
  agent_id uuid not null,
  payload jsonb not null,
  message jsonb,
  reply_text text,
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  received_at timestamptz not null default now(),
  completed_at timestamptz
);

create index relay_event_inbox_pending on public.relay_event_inbox (next_attempt_at, received_at)
  where completed_at is null and attempts < 5;

alter table public.relay_event_inbox enable row level security;
revoke all on public.relay_event_inbox from public, anon, authenticated;
grant select, insert, update on public.relay_event_inbox to service_role;
