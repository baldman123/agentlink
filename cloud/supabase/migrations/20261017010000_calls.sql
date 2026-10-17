-- "Your calls" (contracts/calls.ts): the yes/no decisions the claude4 boss passes to a team's owner, mirrored by
-- that person's daemon. Written and read only by the API with the service role, always for the calling person:
-- no client policies, not in Realtime (the UI polls GET /api/calls).

create table public.calls (
  username    text not null references public.people (username) on delete cascade,
  id          text not null check (id ~ '^[A-Za-z0-9]{2,20}$'),   -- the claude4 id
  kind        text not null check (kind in ('permission', 'question')),
  summary     text not null check (length(summary) between 1 and 400), -- one plain-English sentence
  details     text not null default '',                              -- the raw command or full question
  why         text,
  from_label  text not null,                                         -- "the boss", "quarter 2"
  asked_at    timestamptz not null,
  state       text not null default 'pending' check (state in ('pending', 'answering')),
  choice      text check (choice in ('yes', 'no')),
  note        text check (length(note) <= 500),
  answered_at timestamptz,
  updated_at  timestamptz not null default now(),
  primary key (username, id)
);
create index calls_user_asked on public.calls (username, asked_at);

alter table public.calls enable row level security;
revoke all on public.calls from anon, authenticated;
grant all on public.calls to service_role;

-- One daemon sync, atomically: upsert the listed calls (an answered row keeps its state and answer), delete the
-- person's rows that aren't listed (answered on the boss circle, or delivered), and return the listed rows that
-- were answered on the site, for the daemon to deliver.
create function public.agentlink_sync_calls(p_user text, p_calls jsonb)
returns table (id text, choice text, note text)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
begin
  delete from public.calls c
  where c.username = p_user
    and not exists (select 1 from jsonb_array_elements(coalesce(p_calls, '[]'::jsonb)) e where e->>'id' = c.id);

  insert into public.calls as c (username, id, kind, summary, details, why, from_label, asked_at)
  select p_user, e->>'id', e->>'kind', e->>'summary', coalesce(e->>'details', ''), e->>'why', e->>'from', (e->>'asked_at')::timestamptz
  from jsonb_array_elements(coalesce(p_calls, '[]'::jsonb)) e
  on conflict (username, id) do update
    set kind = excluded.kind, summary = excluded.summary, details = excluded.details, why = excluded.why,
        from_label = excluded.from_label, asked_at = excluded.asked_at, updated_at = now()
    where (c.kind, c.summary, c.details, c.why, c.from_label, c.asked_at)
      is distinct from (excluded.kind, excluded.summary, excluded.details, excluded.why, excluded.from_label, excluded.asked_at);

  return query
    select c.id, c.choice, coalesce(c.note, '') from public.calls c
    where c.username = p_user and c.state = 'answering'
    order by c.answered_at;
end
$$;

revoke all on function public.agentlink_sync_calls(text, jsonb) from public, anon, authenticated;
grant execute on function public.agentlink_sync_calls(text, jsonb) to service_role;
