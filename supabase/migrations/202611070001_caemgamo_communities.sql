create extension if not exists pgcrypto with schema extensions;

do $$ begin
  create type public.community_role as enum ('owner', 'admin', 'mod', 'member');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.channel_kind as enum ('text', 'voice');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.moderation_action as enum ('warning', 'mute', 'kick', 'ban');
exception when duplicate_object then null; end $$;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default 'Participante' check (char_length(display_name) between 1 and 32),
  avatar_path text,
  preferred_theme text not null default 'dark' check (preferred_theme in ('light', 'dark', 'navy')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.create_profile_for_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles(id, display_name)
  values (new.id, coalesce(nullif(left(new.raw_user_meta_data ->> 'display_name', 32), ''), 'Participante'))
  on conflict (id) do nothing;
  return new;
end;
$$;
drop trigger if exists caemgamo_profile_on_signup on auth.users;
create trigger caemgamo_profile_on_signup after insert on auth.users
for each row execute function public.create_profile_for_user();
insert into public.profiles(id, display_name)
select u.id, coalesce(nullif(left(u.raw_user_meta_data ->> 'display_name', 32), ''), 'Participante')
from auth.users u
on conflict (id) do nothing;

create table if not exists public.communities (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 2 and 64),
  description text not null default '' check (char_length(description) <= 500),
  rules text not null default '' check (char_length(rules) <= 3000),
  icon_path text,
  is_public boolean not null default false,
  owner_id uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);

create table if not exists public.community_members (
  community_id uuid not null references public.communities(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.community_role not null default 'member',
  joined_at timestamptz not null default now(),
  primary key (community_id, user_id)
);
create index if not exists community_members_user_idx on public.community_members(user_id, community_id);

create table if not exists public.channels (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 48),
  kind public.channel_kind not null default 'text',
  read_min_role public.community_role not null default 'member',
  post_min_role public.community_role not null default 'member',
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  unique (community_id, name),
  check (kind = 'text' or post_min_role in ('member', 'mod', 'admin', 'owner'))
);
create index if not exists channels_community_idx on public.channels(community_id, kind);

create table if not exists public.community_invites (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id) on delete cascade,
  token_hash bytea not null unique,
  created_by uuid not null references auth.users(id),
  expires_at timestamptz,
  max_uses integer check (max_uses is null or max_uses > 0),
  use_count integer not null default 0 check (use_count >= 0),
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  channel_id uuid not null references public.channels(id) on delete cascade,
  author_id uuid not null references auth.users(id) on delete cascade,
  message_type text not null default 'text' check (message_type in ('text','sticker','audio')),
  content text not null default '' check (char_length(content) <= 2000),
  media_path text,
  duration_seconds numeric,
  created_at timestamptz not null default now()
  ,constraint message_payload_valid check (
    (message_type = 'text' and char_length(content) between 1 and 2000 and media_path is null and duration_seconds is null)
    or (message_type = 'sticker' and content in ('🎉','👋','😂','👍','❤️','🎮','✨','🔥') and media_path is null and duration_seconds is null)
    or (message_type = 'audio' and char_length(content) <= 250 and media_path is not null and duration_seconds is not null and duration_seconds between 1 and 30)
  )
);
create index if not exists messages_channel_created_idx on public.messages(channel_id, created_at desc);

create or replace function public.limit_message_rate()
returns trigger language plpgsql security definer set search_path = '' as $$
declare recent_count integer;
begin
  perform pg_advisory_xact_lock(hashtextextended(new.channel_id::text || ':' || new.author_id::text, 0));
  select count(*) into recent_count from public.messages m
  where m.channel_id = new.channel_id and m.author_id = new.author_id
    and m.created_at > now() - interval '10 seconds';
  if recent_count >= 5 then raise exception 'message_rate_limited'; end if;
  return new;
end;
$$;
drop trigger if exists caemgamo_message_rate_limit on public.messages;
create trigger caemgamo_message_rate_limit before insert on public.messages
for each row execute function public.limit_message_rate();

create table if not exists public.moderation_cases (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id) on delete cascade,
  subject_id uuid not null references auth.users(id) on delete cascade,
  actor_id uuid not null references auth.users(id),
  prior_role public.community_role,
  action public.moderation_action not null,
  reason text not null default '' check (char_length(reason) <= 500),
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists moderation_active_idx on public.moderation_cases(community_id, subject_id, action, expires_at)
where revoked_at is null;

create table if not exists public.audit_logs (
  id bigint generated always as identity primary key,
  community_id uuid not null references public.communities(id) on delete cascade,
  actor_id uuid not null references auth.users(id),
  subject_id uuid references auth.users(id),
  action text not null check (char_length(action) between 1 and 64),
  reason text not null default '' check (char_length(reason) <= 500),
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists audit_logs_community_created_idx on public.audit_logs(community_id, created_at desc);

create or replace function public.community_role_rank(p_role public.community_role)
returns integer language sql immutable as $$
  select case p_role when 'owner' then 4 when 'admin' then 3 when 'mod' then 2 else 1 end;
$$;

create or replace function public.is_community_banned(p_community_id uuid, p_user_id uuid default auth.uid())
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.moderation_cases mc
    where mc.community_id = p_community_id and mc.subject_id = p_user_id
      and mc.action = 'ban' and mc.revoked_at is null
      and (mc.expires_at is null or mc.expires_at > now())
  );
$$;

create or replace function public.is_community_kicked(p_community_id uuid, p_user_id uuid default auth.uid())
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.moderation_cases mc
    where mc.community_id = p_community_id and mc.subject_id = p_user_id
      and mc.action = 'kick' and mc.revoked_at is null
      and (mc.expires_at is null or mc.expires_at > now())
  );
$$;

create or replace function public.is_community_member(p_community_id uuid, p_user_id uuid default auth.uid())
returns boolean language sql stable security definer set search_path = '' as $$
  select p_user_id is not null
    and (p_user_id = auth.uid() or exists (
      select 1 from public.community_members caller
      where caller.community_id = p_community_id and caller.user_id = auth.uid()
    ))
    and exists (
    select 1 from public.community_members cm
    where cm.community_id = p_community_id and cm.user_id = p_user_id
  ) and not public.is_community_banned(p_community_id, p_user_id);
$$;

create or replace function public.member_role(p_community_id uuid, p_user_id uuid default auth.uid())
returns public.community_role language sql stable security definer set search_path = '' as $$
  select cm.role from public.community_members cm
  where cm.community_id = p_community_id and cm.user_id = p_user_id
    and (p_user_id = auth.uid() or exists (
      select 1 from public.community_members caller
      where caller.community_id = p_community_id and caller.user_id = auth.uid()
    ))
    and not public.is_community_banned(p_community_id, p_user_id)
  limit 1;
$$;

create or replace function public.can_access_channel(p_channel_id uuid, p_write boolean default false)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.channels c
    join public.community_members cm on cm.community_id = c.community_id and cm.user_id = auth.uid()
    where c.id = p_channel_id
      and public.community_role_rank(cm.role) >= public.community_role_rank(c.read_min_role)
      and not public.is_community_banned(c.community_id, auth.uid())
      and (not p_write or c.kind = 'text')
      and (not p_write or (
        public.community_role_rank(cm.role) >= public.community_role_rank(c.post_min_role)
        and not exists (
          select 1 from public.moderation_cases mc
          where mc.community_id = c.community_id and mc.subject_id = auth.uid()
            and mc.action = 'mute' and mc.revoked_at is null
            and (mc.expires_at is null or mc.expires_at > now())
        )
      ))
  );
$$;

create or replace function public.create_community(p_name text, p_description text default '', p_is_public boolean default false, p_rules text default '')
returns uuid language plpgsql security definer set search_path = '' as $$
declare new_id uuid;
begin
  if auth.uid() is null then raise exception 'authentication required'; end if;
  insert into public.communities(name, description, is_public, rules, owner_id)
  values (trim(p_name), coalesce(p_description, ''), coalesce(p_is_public, false), coalesce(p_rules, ''), auth.uid())
  returning id into new_id;
  insert into public.community_members(community_id, user_id, role) values (new_id, auth.uid(), 'owner');
  insert into public.channels(community_id, name, kind, created_by) values
    (new_id, 'geral', 'text', auth.uid()), (new_id, 'voz', 'voice', auth.uid());
  insert into public.audit_logs(community_id, actor_id, action, details)
  values (new_id, auth.uid(), 'community_created', jsonb_build_object('name', trim(p_name)));
  return new_id;
end;
$$;

create or replace function public.create_channel(p_community_id uuid, p_name text, p_kind public.channel_kind, p_read_min_role public.community_role default 'member', p_post_min_role public.community_role default 'member')
returns uuid language plpgsql security definer set search_path = '' as $$
declare actor_role public.community_role; new_id uuid;
begin
  actor_role := public.member_role(p_community_id);
  if actor_role is null or public.community_role_rank(actor_role) < 3 then raise exception 'insufficient permission'; end if;
  insert into public.channels(community_id, name, kind, read_min_role, post_min_role, created_by)
  values (p_community_id, trim(p_name), p_kind, p_read_min_role, p_post_min_role, auth.uid()) returning id into new_id;
  insert into public.audit_logs(community_id, actor_id, action, details)
  values (p_community_id, auth.uid(), 'channel_created', jsonb_build_object('channel_id', new_id, 'kind', p_kind));
  return new_id;
end;
$$;

create or replace function public.create_community_invite(p_community_id uuid, p_token text, p_expires_at timestamptz default null, p_max_uses integer default null)
returns uuid language plpgsql security definer set search_path = 'public, extensions' as $$
declare actor_role public.community_role; invite_id uuid;
begin
  if char_length(p_token) < 32 or char_length(p_token) > 160 then raise exception 'invalid invite token'; end if;
  if p_max_uses is not null and p_max_uses < 1 then raise exception 'invalid use limit'; end if;
  actor_role := public.member_role(p_community_id);
  if actor_role is null or public.community_role_rank(actor_role) < 2 then raise exception 'insufficient permission'; end if;
  insert into public.community_invites(community_id, token_hash, created_by, expires_at, max_uses)
  values (p_community_id, extensions.digest(p_token, 'sha256'), auth.uid(), p_expires_at, p_max_uses)
  returning id into invite_id;
  insert into public.audit_logs(community_id, actor_id, action, details)
  values (p_community_id, auth.uid(), 'invite_created', jsonb_build_object('invite_id', invite_id, 'expires_at', p_expires_at, 'max_uses', p_max_uses));
  return invite_id;
end;
$$;

create or replace function public.revoke_community_invite(p_invite_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare invite_row public.community_invites%rowtype; actor_role public.community_role;
begin
  select * into invite_row from public.community_invites where id = p_invite_id for update;
  if invite_row.id is null then raise exception 'invite not found'; end if;
  actor_role := public.member_role(invite_row.community_id);
  if actor_role is null or public.community_role_rank(actor_role) < 2 then raise exception 'insufficient permission'; end if;
  update public.community_invites set revoked_at = now() where id = p_invite_id and revoked_at is null;
  if not found then raise exception 'invite already revoked'; end if;
  insert into public.audit_logs(community_id, actor_id, action, details)
  values (invite_row.community_id, auth.uid(), 'invite_revoked', jsonb_build_object('invite_id', p_invite_id));
end;
$$;

create or replace function public.update_community_settings(p_community_id uuid, p_name text, p_description text, p_rules text, p_is_public boolean, p_icon_path text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare actor_role public.community_role;
begin
  actor_role := public.member_role(p_community_id);
  if actor_role is null or public.community_role_rank(actor_role) < 3 then raise exception 'insufficient permission'; end if;
  if p_icon_path is not null and p_icon_path !~ ('^' || p_community_id::text || '/[A-Za-z0-9._-]+$') then raise exception 'invalid icon path'; end if;
  update public.communities set name = trim(p_name), description = coalesce(p_description, ''), rules = coalesce(p_rules, ''), is_public = coalesce(p_is_public, false), icon_path = p_icon_path
  where id = p_community_id;
  insert into public.audit_logs(community_id, actor_id, action)
  values (p_community_id, auth.uid(), 'community_settings_updated');
end;
$$;

create or replace function public.join_community_by_invite(p_token text)
returns uuid language plpgsql security definer set search_path = 'public, extensions' as $$
declare invite_row public.community_invites%rowtype;
begin
  if auth.uid() is null then raise exception 'authentication required'; end if;
  if char_length(p_token) < 32 or char_length(p_token) > 160 then raise exception 'invalid invite'; end if;
  update public.community_invites ci set use_count = use_count + 1
  where ci.token_hash = extensions.digest(p_token, 'sha256')
    and ci.revoked_at is null and (ci.expires_at is null or ci.expires_at > now())
    and (ci.max_uses is null or ci.use_count < ci.max_uses)
  returning ci.* into invite_row;
  if invite_row.id is null then raise exception 'invite is unavailable'; end if;
  if public.is_community_banned(invite_row.community_id, auth.uid()) or public.is_community_kicked(invite_row.community_id, auth.uid()) then raise exception 'not permitted'; end if;
  insert into public.community_members(community_id, user_id, role)
  values (invite_row.community_id, auth.uid(), 'member') on conflict (community_id, user_id) do nothing;
  insert into public.audit_logs(community_id, actor_id, action, details)
  values (invite_row.community_id, auth.uid(), 'member_joined', jsonb_build_object('invite_id', invite_row.id));
  return invite_row.community_id;
end;
$$;

create or replace function public.join_public_community(p_community_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'authentication required'; end if;
  if not exists (select 1 from public.communities where id = p_community_id and is_public) then raise exception 'community unavailable'; end if;
  if public.is_community_banned(p_community_id, auth.uid()) or public.is_community_kicked(p_community_id, auth.uid()) then raise exception 'not permitted'; end if;
  insert into public.community_members(community_id, user_id, role) values(p_community_id, auth.uid(), 'member') on conflict do nothing;
  insert into public.audit_logs(community_id, actor_id, action) values(p_community_id, auth.uid(), 'member_joined_public');
  return p_community_id;
end;
$$;

create or replace function public.assign_community_role(p_community_id uuid, p_user_id uuid, p_role public.community_role)
returns void language plpgsql security definer set search_path = '' as $$
declare actor_role public.community_role; target_role public.community_role;
begin
  actor_role := public.member_role(p_community_id);
  select cm.role into target_role from public.community_members cm where cm.community_id = p_community_id and cm.user_id = p_user_id for update;
  if actor_role is null or target_role is null or public.community_role_rank(actor_role) < 3 then raise exception 'insufficient permission'; end if;
  if p_role = 'owner' or public.community_role_rank(actor_role) <= public.community_role_rank(target_role)
    or public.community_role_rank(actor_role) <= public.community_role_rank(p_role) then raise exception 'role change exceeds actor permission'; end if;
  update public.community_members set role = p_role where community_id = p_community_id and user_id = p_user_id;
  insert into public.audit_logs(community_id, actor_id, subject_id, action, details)
  values (p_community_id, auth.uid(), p_user_id, 'role_assigned', jsonb_build_object('role', p_role));
end;
$$;

create or replace function public.moderate_community_member(p_community_id uuid, p_user_id uuid, p_action public.moderation_action, p_reason text default '', p_duration_seconds integer default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare actor_role public.community_role; target_role public.community_role; case_id uuid; expiry timestamptz;
begin
  actor_role := public.member_role(p_community_id);
  select cm.role into target_role from public.community_members cm where cm.community_id = p_community_id and cm.user_id = p_user_id for update;
  if actor_role is null or target_role is null or public.community_role_rank(actor_role) < 2 then raise exception 'insufficient permission'; end if;
  if p_user_id = auth.uid() or public.community_role_rank(actor_role) <= public.community_role_rank(target_role) then raise exception 'cannot moderate equal or higher role'; end if;
  if p_action in ('mute', 'kick', 'ban') and p_duration_seconds is not null and (p_duration_seconds < 60 or p_duration_seconds > 31536000) then raise exception 'invalid duration'; end if;
  if p_action in ('mute', 'kick', 'ban') and p_duration_seconds is null and p_action <> 'ban' then raise exception 'duration required'; end if;
  expiry := case when p_duration_seconds is null then null else now() + make_interval(secs => p_duration_seconds) end;
  insert into public.moderation_cases(community_id, subject_id, actor_id, prior_role, action, reason, expires_at)
  values (p_community_id, p_user_id, auth.uid(), target_role, p_action, coalesce(p_reason, ''), expiry) returning id into case_id;
  if p_action in ('kick', 'ban') then delete from public.community_members where community_id = p_community_id and user_id = p_user_id; end if;
  insert into public.audit_logs(community_id, actor_id, subject_id, action, reason, details)
  values (p_community_id, auth.uid(), p_user_id, p_action::text, coalesce(p_reason, ''), jsonb_build_object('case_id', case_id, 'expires_at', expiry));
  return case_id;
end;
$$;

create or replace function public.revoke_moderation_case(p_case_id uuid, p_reason text default '')
returns void language plpgsql security definer set search_path = '' as $$
declare case_row public.moderation_cases%rowtype; actor_role public.community_role; target_role public.community_role;
begin
  select * into case_row from public.moderation_cases where id = p_case_id for update;
  if case_row.id is null then raise exception 'case not found'; end if;
  actor_role := public.member_role(case_row.community_id);
  target_role := public.member_role(case_row.community_id, case_row.subject_id);
  if actor_role is null or public.community_role_rank(actor_role) < 2 or actor_role = 'mod' and case_row.actor_id <> auth.uid() then raise exception 'insufficient permission'; end if;
  if target_role is not null and public.community_role_rank(actor_role) <= public.community_role_rank(target_role) then raise exception 'cannot modify equal or higher role'; end if;
  update public.moderation_cases set revoked_at = now() where id = p_case_id and revoked_at is null;
  if not found then raise exception 'case already revoked'; end if;
  if case_row.action in ('kick', 'ban') and not public.is_community_banned(case_row.community_id, case_row.subject_id) then
    insert into public.community_members(community_id, user_id, role) values(case_row.community_id, case_row.subject_id, coalesce(case_row.prior_role, 'member')) on conflict do nothing;
  end if;
  insert into public.audit_logs(community_id, actor_id, subject_id, action, reason, details)
  values (case_row.community_id, auth.uid(), case_row.subject_id, 'moderation_revoked', coalesce(p_reason, ''), jsonb_build_object('case_id', p_case_id));
end;
$$;

create or replace function public.transfer_community_ownership(p_community_id uuid, p_new_owner_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if public.member_role(p_community_id) <> 'owner' then raise exception 'owner required'; end if;
  if p_new_owner_id = auth.uid() or not exists (select 1 from public.community_members where community_id = p_community_id and user_id = p_new_owner_id) then raise exception 'new owner must be another member'; end if;
  update public.community_members set role = 'admin' where community_id = p_community_id and user_id = auth.uid();
  update public.community_members set role = 'owner' where community_id = p_community_id and user_id = p_new_owner_id;
  update public.communities set owner_id = p_new_owner_id where id = p_community_id;
  insert into public.audit_logs(community_id, actor_id, subject_id, action)
  values (p_community_id, auth.uid(), p_new_owner_id, 'ownership_transferred');
end;
$$;

create or replace function public.leave_community(p_community_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare actor_role public.community_role;
begin
  actor_role := public.member_role(p_community_id);
  if actor_role is null then raise exception 'membership required'; end if;
  if actor_role = 'owner' then raise exception 'transfer ownership before leaving'; end if;
  delete from public.community_members where community_id = p_community_id and user_id = auth.uid();
  insert into public.audit_logs(community_id, actor_id, action) values (p_community_id, auth.uid(), 'member_left');
end;
$$;

create or replace function public.can_join_voice_channel(p_channel_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and exists (
    select 1 from public.channels c
    where c.id = p_channel_id and c.kind = 'voice'
      and public.can_access_channel(c.id, false)
  );
$$;

-- Public table grants are revoked explicitly; policies alone do not remove SQL privileges.
revoke all on public.profiles, public.communities, public.community_members, public.channels,
  public.community_invites, public.messages, public.moderation_cases, public.audit_logs
  from anon, authenticated;
grant select on public.profiles to authenticated;
grant update (display_name, avatar_path, preferred_theme) on public.profiles to authenticated;
grant select on public.communities, public.community_members, public.channels, public.messages to authenticated;
grant insert (channel_id, author_id, message_type, content, media_path, duration_seconds) on public.messages to authenticated;
grant select on public.moderation_cases, public.audit_logs to authenticated;
grant usage, select on sequence public.audit_logs_id_seq to authenticated;

alter table public.profiles enable row level security;
alter table public.communities enable row level security;
alter table public.community_members enable row level security;
alter table public.channels enable row level security;
alter table public.community_invites enable row level security;
alter table public.messages enable row level security;
alter table public.moderation_cases enable row level security;
alter table public.audit_logs enable row level security;

drop policy if exists profiles_read_authenticated on public.profiles;
create policy profiles_read_authenticated on public.profiles for select to authenticated using (true);
drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self on public.profiles for update to authenticated
using (id = (select auth.uid())) with check (id = (select auth.uid()));

drop policy if exists communities_read_public_or_member on public.communities;
create policy communities_read_public_or_member on public.communities for select to authenticated
using (is_public or public.is_community_member(id));
drop policy if exists members_read_community on public.community_members;
create policy members_read_community on public.community_members for select to authenticated
using (user_id = (select auth.uid()) or public.is_community_member(community_id));
drop policy if exists channels_read_accessible on public.channels;
create policy channels_read_accessible on public.channels for select to authenticated
using (public.can_access_channel(id, false));
drop policy if exists messages_read_accessible on public.messages;
create policy messages_read_accessible on public.messages for select to authenticated
using (public.can_access_channel(channel_id, false));
drop policy if exists messages_insert_authorized on public.messages;
create policy messages_insert_authorized on public.messages for insert to authenticated
with check (author_id = (select auth.uid()) and public.can_access_channel(channel_id, true)
  and (message_type <> 'audio' or media_path like channel_id::text || '/' || (select auth.uid())::text || '/%'));
drop policy if exists moderation_read_privileged on public.moderation_cases;
create policy moderation_read_privileged on public.moderation_cases for select to authenticated
using (subject_id = (select auth.uid()) or public.community_role_rank(public.member_role(community_id)) >= 2);
drop policy if exists audit_read_privileged on public.audit_logs;
create policy audit_read_privileged on public.audit_logs for select to authenticated
using (public.community_role_rank(public.member_role(community_id)) >= 2);

revoke execute on all functions in schema public from public, anon;
grant execute on function public.community_role_rank(public.community_role) to authenticated;
grant execute on function public.is_community_member(uuid, uuid) to authenticated;
grant execute on function public.member_role(uuid, uuid) to authenticated;
grant execute on function public.can_access_channel(uuid, boolean) to authenticated;
grant execute on function public.create_community(text, text, boolean, text) to authenticated;
grant execute on function public.create_channel(uuid, text, public.channel_kind, public.community_role, public.community_role) to authenticated;
grant execute on function public.create_community_invite(uuid, text, timestamptz, integer) to authenticated;
grant execute on function public.revoke_community_invite(uuid) to authenticated;
grant execute on function public.update_community_settings(uuid, text, text, text, boolean, text) to authenticated;
grant execute on function public.join_community_by_invite(text) to authenticated;
grant execute on function public.join_public_community(uuid) to authenticated;
grant execute on function public.assign_community_role(uuid, uuid, public.community_role) to authenticated;
grant execute on function public.moderate_community_member(uuid, uuid, public.moderation_action, text, integer) to authenticated;
grant execute on function public.revoke_moderation_case(uuid, text) to authenticated;
grant execute on function public.transfer_community_ownership(uuid, uuid) to authenticated;
grant execute on function public.leave_community(uuid) to authenticated;
grant execute on function public.can_join_voice_channel(uuid) to authenticated;

insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', true, 3145728, array['image/jpeg','image/png','image/webp'])
on conflict (id) do update set public = true, file_size_limit = 3145728, allowed_mime_types = excluded.allowed_mime_types;
drop policy if exists avatars_public_read on storage.objects;
create policy avatars_public_read on storage.objects for select using (bucket_id = 'avatars');
drop policy if exists avatars_owner_upload on storage.objects;
create policy avatars_owner_upload on storage.objects for insert to authenticated
with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);
drop policy if exists avatars_owner_update on storage.objects;
create policy avatars_owner_update on storage.objects for update to authenticated
using (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text)
with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);
drop policy if exists avatars_owner_delete on storage.objects;
create policy avatars_owner_delete on storage.objects for delete to authenticated
using (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);

insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('community-icons', 'community-icons', true, 3145728, array['image/jpeg','image/png','image/webp'])
on conflict (id) do update set public = true, file_size_limit = 3145728, allowed_mime_types = excluded.allowed_mime_types;
drop policy if exists community_icons_public_read on storage.objects;
create policy community_icons_public_read on storage.objects for select using (bucket_id = 'community-icons');
drop policy if exists community_icons_manager_upload on storage.objects;
create policy community_icons_manager_upload on storage.objects for insert to authenticated
with check (bucket_id = 'community-icons' and exists (
  select 1 from public.communities c where c.id::text = (storage.foldername(name))[1]
    and public.community_role_rank(public.member_role(c.id)) >= 3
));
drop policy if exists community_icons_manager_update on storage.objects;
create policy community_icons_manager_update on storage.objects for update to authenticated
using (bucket_id = 'community-icons' and exists (
  select 1 from public.communities c where c.id::text = (storage.foldername(name))[1]
    and public.community_role_rank(public.member_role(c.id)) >= 3
))
with check (bucket_id = 'community-icons' and exists (
  select 1 from public.communities c where c.id::text = (storage.foldername(name))[1]
    and public.community_role_rank(public.member_role(c.id)) >= 3
));
drop policy if exists community_icons_manager_delete on storage.objects;
create policy community_icons_manager_delete on storage.objects for delete to authenticated
using (bucket_id = 'community-icons' and exists (
  select 1 from public.communities c where c.id::text = (storage.foldername(name))[1]
    and public.community_role_rank(public.member_role(c.id)) >= 3
));

insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('chat-media', 'chat-media', false, 10485760, array['audio/webm','audio/ogg','audio/mp4','audio/mpeg','audio/wav'])
on conflict (id) do update set public = false, file_size_limit = 10485760, allowed_mime_types = excluded.allowed_mime_types;
drop policy if exists chat_media_read_member on storage.objects;
create policy chat_media_read_member on storage.objects for select to authenticated
using (bucket_id = 'chat-media' and public.can_access_channel(((storage.foldername(name))[1])::uuid, false));
drop policy if exists chat_media_upload_member on storage.objects;
create policy chat_media_upload_member on storage.objects for insert to authenticated
with check (bucket_id = 'chat-media' and (storage.foldername(name))[2] = (select auth.uid())::text
  and public.can_access_channel(((storage.foldername(name))[1])::uuid, true));
drop policy if exists chat_media_delete_owner on storage.objects;
create policy chat_media_delete_owner on storage.objects for delete to authenticated
using (bucket_id = 'chat-media' and (storage.foldername(name))[2] = (select auth.uid())::text
  and public.can_access_channel(((storage.foldername(name))[1])::uuid, true));

do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'messages') then
    alter publication supabase_realtime add table public.messages;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'moderation_cases') then
    alter publication supabase_realtime add table public.moderation_cases;
  end if;
end $$;
