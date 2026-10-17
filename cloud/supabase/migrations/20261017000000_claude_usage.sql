-- Claude plan usage meters (contracts/usage.ts): the latest /usage sample each person's daemon reported.
-- Written by POST /api/usage with the service role; read by GET /api/usage. No client policies: browsers never
-- read this table directly, so it is not added to Realtime either (the UI polls the API).

create table public.claude_usage (
  username    text primary key references public.people (username) on delete cascade,
  usage       jsonb not null,               -- ClaudeUsage: plan, five_hour, seven_day, scoped[], collected_at
  received_at timestamptz not null default now()
);

alter table public.claude_usage enable row level security;
revoke all on public.claude_usage from anon, authenticated;
grant all on public.claude_usage to service_role;
