-- agentlink cloud schema (contracts/cloud-api.md "Database").
-- Clients (role authenticated, with a JWT the API mints) may only SELECT, and only through app_active().
-- Every write goes through the Vercel API with the service role, which bypasses RLS.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- tables

create table public.settings (
  k text primary key,
  v text not null
);

create table public.people (
  username    text primary key check (username ~ '^[a-z0-9_-]{1,32}$'),
  code_hash   text unique,                 -- sha256(code) hex; null for the owner (the master code lives in env)
  epoch       integer not null default 1,  -- 0 for the owner; +1 on every re-invite
  is_owner    boolean not null default false,
  created_at  timestamptz not null default now(),
  invited_at  timestamptz not null default now(),
  revoked_at  timestamptz,
  last_seen   timestamptz
);

create table public.messages (
  id           text primary key check (length(id) between 1 and 128),
  from_addr    text not null,
  to_addr      text not null,
  from_user    text not null,
  to_user      text,                       -- null for "*"
  reply_to     text,
  hops         integer not null,
  type         text not null,
  body         jsonb not null,
  "timestamp"  text not null,
  state        text not null check (state in ('accepted', 'delivered', 'dropped')),
  accepted_at  timestamptz not null default now(),
  delivered_at timestamptz,
  drop_reason  text
);
create index messages_from_user on public.messages (from_user, accepted_at desc);
create index messages_to_user on public.messages (to_user, accepted_at desc);
create index messages_accepted on public.messages (accepted_at desc);

create table public.deliveries (
  seq        bigserial not null unique,
  message_id text not null references public.messages (id) on delete cascade,
  username   text not null,
  hops       integer not null,
  envelope   jsonb not null,               -- the delivered copy (hops already + 1)
  acked      boolean not null default false,
  acked_at   timestamptz,
  created_at timestamptz not null default now(),
  primary key (message_id, username)
);
create index deliveries_pending on public.deliveries (username, acked, seq);

create table public.sessions (
  address        text primary key,
  username       text not null,
  agent          text not null,
  kind           text not null check (kind in ('orchestrator', 'worker', 'human')),
  status         text not null check (status in ('idle', 'working', 'waiting', 'error', 'offline')),
  task           text not null default '',
  last_activity  timestamptz not null default now(),
  last_heartbeat timestamptz not null default now()
);
create index sessions_user on public.sessions (username);

create table public.context (
  key        text primary key check (key ~ '^[a-z0-9._-]{1,64}$'),
  title      text not null,
  kind       text not null check (kind in ('note', 'decision', 'api_spec')),
  body       text not null,
  author     text not null,
  version    integer not null,
  updated_at timestamptz not null default now()
);

create table public.pane_inputs (
  id         uuid primary key,
  username   text not null,
  agents     text[] not null,
  chars      integer not null,               -- the text itself is never stored
  state      text not null default 'pending' check (state in ('pending', 'done', 'failed')),
  results    jsonb,
  created_at timestamptz not null default now()
);
create index pane_inputs_user on public.pane_inputs (username, created_at desc);

create table public.login_failures (
  ip text not null,
  at timestamptz not null default now()
);
create index login_failures_ip on public.login_failures (ip, at);
create index login_failures_at on public.login_failures (at);

-- ---------------------------------------------------------------- who is asking (RLS helpers)

-- The JWT's app_user, or null.
create function public.app_user() returns text
language sql stable as $$
  select nullif(auth.jwt() ->> 'app_user', '')
$$;

-- True when the JWT belongs to an active person whose epoch still matches (revoked or re-invited -> false at once).
create function public.app_active() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.people p
    where p.username = public.app_user()
      and p.revoked_at is null
      and p.epoch = coalesce((auth.jwt() ->> 'epoch')::integer, -1)
  )
$$;
revoke all on function public.app_active() from public;
grant execute on function public.app_active() to authenticated;

-- ---------------------------------------------------------------- RLS

alter table public.settings enable row level security;
alter table public.people enable row level security;
alter table public.messages enable row level security;
alter table public.deliveries enable row level security;
alter table public.sessions enable row level security;
alter table public.context enable row level security;
alter table public.pane_inputs enable row level security;
alter table public.login_failures enable row level security;
-- settings, people and login_failures: no client policies at all.

create policy messages_read on public.messages for select to authenticated
  using (public.app_active() and (from_user = public.app_user() or to_user = public.app_user() or to_addr = '*'));

create policy deliveries_read on public.deliveries for select to authenticated
  using (public.app_active() and username = public.app_user());

create policy sessions_read on public.sessions for select to authenticated
  using (public.app_active());

create policy context_read on public.context for select to authenticated
  using (public.app_active());

create policy pane_inputs_read on public.pane_inputs for select to authenticated
  using (public.app_active() and username = public.app_user());

-- anon gets nothing; authenticated gets SELECT only (RLS narrows it further); the API's service role gets everything
-- (granted explicitly: newer Supabase versions no longer grant new public tables to the API roles by default).
revoke all on all tables in schema public from anon, authenticated;
grant select on public.messages, public.deliveries, public.sessions, public.context, public.pane_inputs to authenticated;
grant all on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;

-- ---------------------------------------------------------------- Realtime

alter publication supabase_realtime add table public.messages, public.deliveries, public.sessions, public.context;

-- Private channel authorization (Realtime reads these policies on join).
--   presence, screens        : every active person may join and track presence
--   input:<user>, user:<user>: only <user> may join; nobody but the server (service role) may send
-- (Supabase owns realtime.messages and ships it with RLS enabled; we only add policies.)

create policy agentlink_rt_receive on realtime.messages for select to authenticated
  using (
    public.app_active() and (
      realtime.topic() in ('presence', 'screens')
      or realtime.topic() = 'input:' || public.app_user()
      or realtime.topic() = 'user:' || public.app_user()
    )
  );

-- Clients may write only presence on the shared channels; broadcasts (screens, input, revoked) come from the API.
create policy agentlink_rt_presence on realtime.messages for insert to authenticated
  with check (
    public.app_active()
    and realtime.topic() in ('presence', 'screens')
    and realtime.messages.extension = 'presence'
  );

-- ---------------------------------------------------------------- server-side functions (service role only)

-- Store an accepted message and its deliveries in one transaction. Returns false if the id already existed.
create function public.agentlink_accept_message(m jsonb, recipients text[], delivered jsonb) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  r text;
begin
  insert into public.messages (id, from_addr, to_addr, from_user, to_user, reply_to, hops, type, body, "timestamp", state, drop_reason)
  values (m->>'id', m->>'from', m->>'to', split_part(m->>'from', '/', 1),
          case when m->>'to' = '*' then null else split_part(m->>'to', '/', 1) end,
          m->>'reply_to', (m->>'hops')::integer, m->>'type', m->'body', m->>'timestamp',
          coalesce(m->>'state', 'accepted'), m->>'drop_reason')
  on conflict (id) do nothing;
  if not found then
    return false;
  end if;
  foreach r in array coalesce(recipients, '{}') loop
    insert into public.deliveries (message_id, username, hops, envelope)
    values (m->>'id', r, (delivered->>'hops')::integer, delivered)
    on conflict do nothing;
  end loop;
  return true;
end
$$;

-- Ack the caller's deliveries; a message with no unacked deliveries left becomes delivered. Returns rows acked.
create function public.agentlink_ack(p_user text, p_ids text[]) returns integer
language plpgsql security definer set search_path = public as $$
declare
  n integer;
begin
  with done as (
    update public.deliveries set acked = true, acked_at = now()
    where username = p_user and message_id = any (p_ids) and not acked
    returning message_id
  )
  select count(*) into n from done;
  update public.messages m set state = 'delivered', delivered_at = now()
  where m.id = any (p_ids) and m.state = 'accepted'
    and not exists (select 1 from public.deliveries d where d.message_id = m.id and not d.acked);
  return n;
end
$$;

-- Upsert a session, touching the row only when kind/status/task changed (keeps Realtime quiet).
create function public.agentlink_upsert_session(p_user text, p_agent text, p_kind text, p_status text, p_task text)
returns public.sessions
language plpgsql security definer set search_path = public as $$
declare
  s public.sessions;
begin
  insert into public.sessions (address, username, agent, kind, status, task)
  values (p_user || '/' || p_agent, p_user, p_agent, p_kind, p_status, p_task)
  on conflict (address) do update
    set kind = excluded.kind, status = excluded.status, task = excluded.task,
        last_activity = now(), last_heartbeat = now()
    where (sessions.kind, sessions.status, sessions.task) is distinct from (excluded.kind, excluded.status, excluded.task);
  select * into s from public.sessions where address = p_user || '/' || p_agent;
  return s;
end
$$;

-- Heartbeat: the person's last_seen and the listed sessions' last_heartbeat. sessions.last_heartbeat changes do publish
-- to Realtime, so this updates only rows whose heartbeat is older than 20s (one event per session per ~20s at most).
create function public.agentlink_heartbeat(p_user text, p_agents text[]) returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.people set last_seen = now() where username = p_user;
  update public.sessions set last_heartbeat = now()
  where username = p_user and agent = any (p_agents) and last_heartbeat < now() - interval '20 seconds';
end
$$;

-- Context write with optimistic versioning. Returns {status: 200|409, entry|current}.
create function public.agentlink_put_context(p_key text, p_title text, p_kind text, p_body text, p_author text, p_base integer)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  cur public.context;
  nxt public.context;
begin
  select * into cur from public.context where key = p_key for update;
  if p_base is not null and p_base <> coalesce(cur.version, 0) then
    return jsonb_build_object('status', 409, 'current', to_jsonb(cur));
  end if;
  insert into public.context (key, title, kind, body, author, version, updated_at)
  values (p_key, p_title, p_kind, p_body, p_author, coalesce(cur.version, 0) + 1, now())
  on conflict (key) do update set title = excluded.title, kind = excluded.kind, body = excluded.body,
    author = excluded.author, version = excluded.version, updated_at = excluded.updated_at
  returning * into nxt;
  return jsonb_build_object('status', 200, 'entry', to_jsonb(nxt));
end
$$;

revoke all on function public.agentlink_accept_message(jsonb, text[], jsonb) from public, anon, authenticated;
revoke all on function public.agentlink_ack(text, text[]) from public, anon, authenticated;
revoke all on function public.agentlink_upsert_session(text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.agentlink_heartbeat(text, text[]) from public, anon, authenticated;
revoke all on function public.agentlink_put_context(text, text, text, text, text, integer) from public, anon, authenticated;
grant execute on function public.agentlink_accept_message(jsonb, text[], jsonb), public.agentlink_ack(text, text[]),
  public.agentlink_upsert_session(text, text, text, text, text), public.agentlink_heartbeat(text, text[]),
  public.agentlink_put_context(text, text, text, text, text, integer) to service_role;
grant execute on function public.app_user() to authenticated;
