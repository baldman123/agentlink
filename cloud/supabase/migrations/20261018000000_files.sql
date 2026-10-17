-- Files relayed through the website (contracts/uploads.md "Website"). The bytes live in a private Storage bucket and
-- move with signed URLs, never through the API. This table says who sent each file and who may read it. Written and
-- read only by the API with the service role: no client policies, not in Realtime.

create table public.files (
  id           uuid primary key,                                     -- the sending daemon's upload id, or a new uuid
  uploader     text not null references public.people (username) on delete cascade,
  recipients   text[] not null default '{}',                         -- users who may read it; '*' = everyone. Grows as messages naming it are accepted
  name         text not null check (length(name) between 1 and 255), -- sanitised, extension kept
  size         bigint not null check (size between 0 and 209715200), -- UPLOAD_MAX_HUB_BYTES (200 MB)
  sha256       text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  mime         text check (mime is null or length(mime) <= 255),
  storage_path text not null unique,                                 -- '<uploader>/<id>' in the bucket
  created_at   timestamptz not null default now(),
  uploaded_at  timestamptz,                                          -- set once Storage holds every byte
  expires_at   timestamptz not null                                  -- created_at + 7 days; then the row and the object go
);
create index files_expires on public.files (expires_at);
create index files_uploader on public.files (uploader);

alter table public.files enable row level security;
revoke all on public.files from anon, authenticated;
grant all on public.files to service_role;

-- Add readers to files, once each. Called when a message naming the files is accepted.
create function public.agentlink_add_file_recipients(p_ids uuid[], p_recipients text[])
returns void
language sql security definer set search_path = public as $$
  update public.files f
     set recipients = (select array_agg(distinct r order by r) from unnest(f.recipients || p_recipients) as r)
   where f.id = any (p_ids);
$$;

revoke all on function public.agentlink_add_file_recipients(uuid[], text[]) from public, anon, authenticated;
grant execute on function public.agentlink_add_file_recipients(uuid[], text[]) to service_role;

-- The bucket: private, 200 MB per object, any type. Its name must match AGENTLINK_FILES_BUCKET (default agentlink-files).
-- No storage.objects policies on purpose: only the service role touches it, and clients use the URLs it signs.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('agentlink-files', 'agentlink-files', false, 209715200, null)
on conflict (id) do update
  set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = null;
