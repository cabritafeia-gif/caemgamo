-- Complementary migration for deployed CAEMGAMO projects.
-- Adds free gifts, message reports, configurable community roles, and safer avatar references.

alter table public.profiles drop constraint if exists profile_avatar_reference_valid;
alter table public.profiles add constraint profile_avatar_reference_valid check (
  avatar_path is null
  or avatar_path in ('preset:fox','preset:cat','preset:owl','preset:frog','preset:star','preset:heart','preset:robot','preset:flower')
  or avatar_path like id::text || '/%'
);

create table if not exists public.community_custom_roles (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id) on delete cascade,
  name text not null check (char_length(name) between 2 and 32),
  rank integer not null check (rank between 1 and 3),
  permissions jsonb not null default '{}'::jsonb check (jsonb_typeof(permissions) = 'object'),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (community_id, name),
  unique (community_id, id)
);
create index if not exists community_custom_roles_community_idx on public.community_custom_roles(community_id, rank desc, name);

alter table public.community_members add column if not exists custom_role_id uuid references public.community_custom_roles(id) on delete set null;
alter table public.moderation_cases add column if not exists prior_custom_role_id uuid references public.community_custom_roles(id) on delete set null;

create table if not exists public.message_reports (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id) on delete cascade,
  message_id uuid not null references public.messages(id) on delete cascade,
  reporter_id uuid not null references auth.users(id) on delete cascade,
  reported_user_id uuid not null references auth.users(id) on delete cascade,
  reason text not null check (char_length(reason) between 3 and 500),
  status text not null default 'open' check (status in ('open','reviewed','actioned','dismissed')),
  resolved_by uuid references auth.users(id),
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  unique (message_id, reporter_id)
);
create index if not exists message_reports_community_status_idx on public.message_reports(community_id, status, created_at desc);

alter table public.messages drop constraint if exists message_payload_valid;
alter table public.messages drop constraint if exists messages_message_type_check;
alter table public.messages add constraint messages_message_type_check check (message_type in ('text','sticker','gift','audio'));
alter table public.messages add constraint message_payload_valid check (
  (message_type = 'text' and char_length(content) between 1 and 2000 and media_path is null and duration_seconds is null)
  or (message_type = 'sticker' and content in ('🎉','👋','😂','👍','❤️','🎮','✨','🔥') and media_path is null and duration_seconds is null)
  or (message_type = 'gift' and content in ('🎁','🌟','💐','🍰','🧸','🚀','💎','🎮') and media_path is null and duration_seconds is null)
  or (message_type = 'audio' and char_length(content) <= 250 and media_path is not null and duration_seconds is not null and duration_seconds between 1 and 30)
);

create or replace function public.community_member_rank(p_community_id uuid, p_user_id uuid default auth.uid())
returns integer language sql stable security definer set search_path = '' as $$
  select case
    when cm.role = 'owner' then 4
    when custom_role.id is not null then custom_role.rank
    else public.community_role_rank(cm.role)
  end
  from public.community_members cm
  left join public.community_custom_roles custom_role on custom_role.id = cm.custom_role_id and custom_role.community_id = cm.community_id
  where cm.community_id = p_community_id and cm.user_id = p_user_id
    and p_user_id is not null
    and (p_user_id = auth.uid() or exists (
      select 1 from public.community_members caller where caller.community_id = p_community_id and caller.user_id = auth.uid()
    ))
    and not public.is_community_banned(p_community_id, p_user_id)
  limit 1;
$$;

create or replace function public.community_has_permission(p_community_id uuid, p_permission text)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(case
    when cm.role = 'owner' then true
    when custom_role.id is not null then coalesce((custom_role.permissions ->> p_permission)::boolean, false)
    when cm.role = 'admin' then p_permission in ('send_messages','join_voice','create_invites','manage_channels','manage_settings','moderate_members','view_audit','view_reports','report_content')
    when cm.role = 'mod' then p_permission in ('send_messages','join_voice','create_invites','moderate_members','view_audit','view_reports','report_content')
    else p_permission in ('send_messages','join_voice','report_content')
  end, false)
  from public.community_members cm
  left join public.community_custom_roles custom_role on custom_role.id = cm.custom_role_id and custom_role.community_id = cm.community_id
  where cm.community_id = p_community_id and cm.user_id = auth.uid()
    and not public.is_community_banned(p_community_id, auth.uid())
  limit 1;
$$;

create or replace function public.can_access_channel(p_channel_id uuid, p_write boolean default false)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.channels c
    join public.community_members cm on cm.community_id = c.community_id and cm.user_id = auth.uid()
    where c.id = p_channel_id
      and public.community_member_rank(c.community_id) >= public.community_role_rank(c.read_min_role)
      and not public.is_community_banned(c.community_id, auth.uid())
      and (not p_write or c.kind = 'text')
      and (not p_write or public.community_has_permission(c.community_id, 'send_messages'))
      and (not p_write or public.community_member_rank(c.community_id) >= public.community_role_rank(c.post_min_role))
      and (not p_write or not exists (
        select 1 from public.moderation_cases mc
        where mc.community_id = c.community_id and mc.subject_id = auth.uid()
          and mc.action = 'mute' and mc.revoked_at is null
          and (mc.expires_at is null or mc.expires_at > now())
      ))
  );
$$;

create or replace function public.save_community_role(
  p_community_id uuid,
  p_role_id uuid,
  p_name text,
  p_rank integer,
  p_permissions jsonb
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare actor_role public.community_role; actor_rank integer; new_id uuid; v_permissions jsonb;
begin
  actor_role := public.member_role(p_community_id);
  actor_rank := public.community_member_rank(p_community_id);
  if actor_role not in ('owner','admin') or actor_rank is null then raise exception 'insufficient permission'; end if;
  if p_rank not between 1 and 3 or p_rank >= actor_rank then raise exception 'role rank exceeds actor permission'; end if;
  if trim(coalesce(p_name, '')) !~ '^.{2,32}$' then raise exception 'invalid role name'; end if;
  v_permissions := coalesce(p_permissions, '{}'::jsonb);
  if jsonb_typeof(v_permissions) <> 'object' or exists (
    select 1 from jsonb_each(v_permissions) item
    where item.key not in ('send_messages','join_voice','create_invites','manage_channels','manage_settings','moderate_members','view_audit','view_reports','report_content')
      or jsonb_typeof(item.value) <> 'boolean'
  ) then raise exception 'invalid role permissions'; end if;
  if p_role_id is null then
    insert into public.community_custom_roles(community_id, name, rank, permissions, created_by)
      values (p_community_id, trim(p_name), p_rank, v_permissions, auth.uid()) returning id into new_id;
    insert into public.audit_logs(community_id, actor_id, action, details)
      values (p_community_id, auth.uid(), 'custom_role_created', jsonb_build_object('role_id', new_id, 'name', trim(p_name), 'rank', p_rank));
  else
    update public.community_custom_roles as custom_role set name = trim(p_name), rank = p_rank, permissions = v_permissions, updated_at = now()
      where id = p_role_id and community_id = p_community_id and rank < actor_rank returning id into new_id;
    if new_id is null then raise exception 'role not found or exceeds actor permission'; end if;
    insert into public.audit_logs(community_id, actor_id, action, details)
      values (p_community_id, auth.uid(), 'custom_role_updated', jsonb_build_object('role_id', new_id, 'name', trim(p_name), 'rank', p_rank));
  end if;
  return new_id;
end;
$$;

create or replace function public.delete_community_role(p_community_id uuid, p_role_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare actor_role public.community_role; actor_rank integer; role_row public.community_custom_roles%rowtype;
begin
  actor_role := public.member_role(p_community_id);
  actor_rank := public.community_member_rank(p_community_id);
  if actor_role not in ('owner','admin') or actor_rank is null then raise exception 'insufficient permission'; end if;
  select * into role_row from public.community_custom_roles where id = p_role_id and community_id = p_community_id for update;
  if role_row.id is null or role_row.rank >= actor_rank then raise exception 'role not found or exceeds actor permission'; end if;
  delete from public.community_custom_roles where id = p_role_id;
  insert into public.audit_logs(community_id, actor_id, action, details)
    values (p_community_id, auth.uid(), 'custom_role_deleted', jsonb_build_object('role_id', p_role_id, 'name', role_row.name));
end;
$$;

create or replace function public.assign_community_custom_role(p_community_id uuid, p_user_id uuid, p_role_id uuid default null)
returns void language plpgsql security definer set search_path = '' as $$
declare actor_role public.community_role; actor_rank integer; target_role public.community_role; target_rank integer; role_row public.community_custom_roles%rowtype;
begin
  actor_role := public.member_role(p_community_id);
  actor_rank := public.community_member_rank(p_community_id);
  select cm.role into target_role from public.community_members cm where cm.community_id = p_community_id and cm.user_id = p_user_id for update;
  target_rank := public.community_member_rank(p_community_id, p_user_id);
  if actor_role not in ('owner','admin') or actor_rank is null or target_role is null then raise exception 'insufficient permission'; end if;
  if target_role = 'owner' or p_user_id = auth.uid() or actor_rank <= target_rank then raise exception 'cannot assign role to equal or higher role'; end if;
  if p_role_id is not null then
    select * into role_row from public.community_custom_roles where id = p_role_id and community_id = p_community_id;
    if role_row.id is null or role_row.rank >= actor_rank then raise exception 'role exceeds actor permission'; end if;
  end if;
  update public.community_members set custom_role_id = p_role_id where community_id = p_community_id and user_id = p_user_id;
  insert into public.audit_logs(community_id, actor_id, subject_id, action, details)
    values (p_community_id, auth.uid(), p_user_id, case when p_role_id is null then 'custom_role_removed' else 'custom_role_assigned' end,
      jsonb_build_object('role_id', p_role_id));
end;
$$;

create or replace function public.create_channel(p_community_id uuid, p_name text, p_kind public.channel_kind, p_read_min_role public.community_role default 'member', p_post_min_role public.community_role default 'member')
returns uuid language plpgsql security definer set search_path = '' as $$
declare new_id uuid;
begin
  if not public.community_has_permission(p_community_id, 'manage_channels') then raise exception 'insufficient permission'; end if;
  insert into public.channels(community_id, name, kind, read_min_role, post_min_role, created_by)
    values (p_community_id, trim(p_name), p_kind, p_read_min_role, p_post_min_role, auth.uid()) returning id into new_id;
  insert into public.audit_logs(community_id, actor_id, action, details)
    values (p_community_id, auth.uid(), 'channel_created', jsonb_build_object('channel_id', new_id, 'kind', p_kind));
  return new_id;
end;
$$;

create or replace function public.create_community_invite(p_community_id uuid, p_token text, p_expires_at timestamptz default null, p_max_uses integer default null)
returns uuid language plpgsql security definer set search_path = 'public, extensions' as $$
declare invite_id uuid;
begin
  if char_length(p_token) < 32 or char_length(p_token) > 160 then raise exception 'invalid invite token'; end if;
  if p_max_uses is not null and p_max_uses < 1 then raise exception 'invalid use limit'; end if;
  if not public.community_has_permission(p_community_id, 'create_invites') then raise exception 'insufficient permission'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_community_id::text, 0));
  if (select count(*) from public.community_invites where community_id = p_community_id and created_by = auth.uid() and created_at > now() - interval '1 hour') >= 30 then raise exception 'invite_rate_limited'; end if;
  insert into public.community_invites(community_id, token_hash, created_by, expires_at, max_uses)
    values (p_community_id, extensions.digest(p_token, 'sha256'), auth.uid(), p_expires_at, p_max_uses) returning id into invite_id;
  insert into public.audit_logs(community_id, actor_id, action, details)
    values (p_community_id, auth.uid(), 'invite_created', jsonb_build_object('invite_id', invite_id, 'expires_at', p_expires_at, 'max_uses', p_max_uses));
  return invite_id;
end;
$$;

create or replace function public.update_community_settings(p_community_id uuid, p_name text, p_description text, p_rules text, p_is_public boolean, p_icon_path text default null)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.community_has_permission(p_community_id, 'manage_settings') then raise exception 'insufficient permission'; end if;
  if p_icon_path is not null and p_icon_path !~ ('^' || p_community_id::text || '/[A-Za-z0-9._-]+$') then raise exception 'invalid icon path'; end if;
  update public.communities set name = trim(p_name), description = coalesce(p_description, ''), rules = coalesce(p_rules, ''), is_public = coalesce(p_is_public, false), icon_path = p_icon_path where id = p_community_id;
  if not found then raise exception 'community not found'; end if;
  insert into public.audit_logs(community_id, actor_id, action) values (p_community_id, auth.uid(), 'community_settings_updated');
end;
$$;

create or replace function public.assign_community_role(p_community_id uuid, p_user_id uuid, p_role public.community_role)
returns void language plpgsql security definer set search_path = '' as $$
declare actor_role public.community_role; actor_rank integer; target_role public.community_role; target_rank integer;
begin
  actor_role := public.member_role(p_community_id);
  actor_rank := public.community_member_rank(p_community_id);
  select cm.role into target_role from public.community_members cm where cm.community_id = p_community_id and cm.user_id = p_user_id for update;
  target_rank := public.community_member_rank(p_community_id, p_user_id);
  if actor_role not in ('owner','admin') or target_role is null then raise exception 'insufficient permission'; end if;
  if p_role = 'owner' or p_user_id = auth.uid() or actor_rank <= target_rank or actor_rank <= public.community_role_rank(p_role) then raise exception 'role change exceeds actor permission'; end if;
  update public.community_members set role = p_role, custom_role_id = null where community_id = p_community_id and user_id = p_user_id;
  insert into public.audit_logs(community_id, actor_id, subject_id, action, details)
    values (p_community_id, auth.uid(), p_user_id, 'role_assigned', jsonb_build_object('role', p_role));
end;
$$;

create or replace function public.moderate_community_member(p_community_id uuid, p_user_id uuid, p_action public.moderation_action, p_reason text default '', p_duration_seconds integer default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare actor_rank integer; target_rank integer; target_role public.community_role; target_custom_role_id uuid; case_id uuid; expiry timestamptz;
begin
  actor_rank := public.community_member_rank(p_community_id);
  select cm.role, cm.custom_role_id into target_role, target_custom_role_id from public.community_members cm
    where cm.community_id = p_community_id and cm.user_id = p_user_id for update;
  target_rank := public.community_member_rank(p_community_id, p_user_id);
  if not public.community_has_permission(p_community_id, 'moderate_members') or actor_rank is null or target_rank is null then raise exception 'insufficient permission'; end if;
  if p_user_id = auth.uid() or actor_rank <= target_rank then raise exception 'cannot moderate equal or higher role'; end if;
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text || ':' || p_community_id::text, 0));
  if (select count(*) from public.moderation_cases where community_id = p_community_id and actor_id = auth.uid() and created_at > now() - interval '10 minutes') >= 30 then raise exception 'moderation_rate_limited'; end if;
  if p_duration_seconds is not null and (p_duration_seconds < 60 or p_duration_seconds > 31536000) then raise exception 'invalid duration'; end if;
  if p_action in ('mute','kick') and p_duration_seconds is null then raise exception 'duration required'; end if;
  expiry := case when p_duration_seconds is null then null else now() + make_interval(secs => p_duration_seconds) end;
  insert into public.moderation_cases(community_id, subject_id, actor_id, prior_role, prior_custom_role_id, action, reason, expires_at)
    values (p_community_id, p_user_id, auth.uid(), target_role, target_custom_role_id, p_action, coalesce(p_reason, ''), expiry) returning id into case_id;
  if p_action in ('kick','ban') then delete from public.community_members where community_id = p_community_id and user_id = p_user_id; end if;
  insert into public.audit_logs(community_id, actor_id, subject_id, action, reason, details)
    values (p_community_id, auth.uid(), p_user_id, p_action::text, coalesce(p_reason, ''), jsonb_build_object('case_id', case_id, 'expires_at', expiry));
  return case_id;
end;
$$;

create or replace function public.revoke_moderation_case(p_case_id uuid, p_reason text default '')
returns void language plpgsql security definer set search_path = '' as $$
declare case_row public.moderation_cases%rowtype; actor_rank integer; target_rank integer; actor_role public.community_role;
begin
  select * into case_row from public.moderation_cases where id = p_case_id for update;
  if case_row.id is null then raise exception 'case not found'; end if;
  actor_role := public.member_role(case_row.community_id);
  actor_rank := public.community_member_rank(case_row.community_id);
  target_rank := public.community_member_rank(case_row.community_id, case_row.subject_id);
  if target_rank is null then
    select coalesce(custom_role.rank, public.community_role_rank(case_row.prior_role)) into target_rank
      from (select 1) as one left join public.community_custom_roles custom_role
        on custom_role.id = case_row.prior_custom_role_id and custom_role.community_id = case_row.community_id;
  end if;
  if not public.community_has_permission(case_row.community_id, 'moderate_members') or actor_rank is null or actor_rank < 2
    or actor_role = 'mod' and case_row.actor_id <> auth.uid() then raise exception 'insufficient permission'; end if;
  if target_rank is null or actor_rank <= target_rank then raise exception 'cannot modify equal or higher role'; end if;
  update public.moderation_cases set revoked_at = now() where id = p_case_id and revoked_at is null;
  if not found then raise exception 'case already revoked'; end if;
  if case_row.action in ('kick','ban') and not public.is_community_banned(case_row.community_id, case_row.subject_id) then
    insert into public.community_members(community_id, user_id, role, custom_role_id)
      values(case_row.community_id, case_row.subject_id, coalesce(case_row.prior_role, 'member'), case_row.prior_custom_role_id) on conflict do nothing;
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
  update public.community_members set role = 'admin', custom_role_id = null where community_id = p_community_id and user_id = auth.uid();
  update public.community_members set role = 'owner', custom_role_id = null where community_id = p_community_id and user_id = p_new_owner_id;
  update public.communities set owner_id = p_new_owner_id where id = p_community_id;
  insert into public.audit_logs(community_id, actor_id, subject_id, action) values (p_community_id, auth.uid(), p_new_owner_id, 'ownership_transferred');
end;
$$;

create or replace function public.can_join_voice_channel(p_channel_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null
    and exists (select 1 from public.channels c where c.id = p_channel_id and c.kind = 'voice' and public.can_access_channel(c.id, false))
    and public.community_has_permission((select c.community_id from public.channels c where c.id = p_channel_id), 'join_voice')
    and not exists (
      select 1 from public.channels c join public.moderation_cases mc on mc.community_id = c.community_id and mc.subject_id = auth.uid()
      where c.id = p_channel_id and mc.action = 'mute' and mc.revoked_at is null and (mc.expires_at is null or mc.expires_at > now())
    );
$$;

create or replace function public.report_community_message(p_message_id uuid, p_reason text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare community_key uuid; message_author uuid; report_id uuid;
begin
  if auth.uid() is null then raise exception 'authentication required'; end if;
  if char_length(trim(coalesce(p_reason,''))) < 3 or char_length(p_reason) > 500 then raise exception 'invalid report reason'; end if;
  select c.community_id, m.author_id into community_key, message_author
    from public.messages m join public.channels c on c.id = m.channel_id where m.id = p_message_id;
  if community_key is null or message_author = auth.uid() or not public.community_has_permission(community_key, 'report_content')
    or not public.can_access_channel((select channel_id from public.messages where id = p_message_id), false) then raise exception 'message is unavailable'; end if;
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text || ':reports', 0));
  if (select count(*) from public.message_reports where reporter_id = auth.uid() and created_at > now() - interval '1 hour') >= 10 then raise exception 'report_rate_limited'; end if;
  insert into public.message_reports(community_id, message_id, reporter_id, reported_user_id, reason)
    values (community_key, p_message_id, auth.uid(), message_author, trim(p_reason)) returning id into report_id;
  insert into public.audit_logs(community_id, actor_id, subject_id, action, reason, details)
    values (community_key, auth.uid(), message_author, 'message_reported', trim(p_reason), jsonb_build_object('report_id', report_id, 'message_id', p_message_id));
  return report_id;
end;
$$;

create or replace function public.resolve_community_message_report(p_report_id uuid, p_status text)
returns void language plpgsql security definer set search_path = '' as $$
declare report_row public.message_reports%rowtype;
begin
  if p_status not in ('reviewed','actioned','dismissed') then raise exception 'invalid report status'; end if;
  select * into report_row from public.message_reports where id = p_report_id for update;
  if report_row.id is null or not public.community_has_permission(report_row.community_id, 'view_reports') then raise exception 'insufficient permission'; end if;
  if report_row.status <> 'open' then raise exception 'report already resolved'; end if;
  update public.message_reports set status = p_status, resolved_by = auth.uid(), resolved_at = now() where id = p_report_id;
  insert into public.audit_logs(community_id, actor_id, subject_id, action, details)
    values (report_row.community_id, auth.uid(), report_row.reported_user_id, 'message_report_resolved', jsonb_build_object('report_id', p_report_id, 'status', p_status));
end;
$$;

revoke all on public.community_custom_roles, public.message_reports from anon, authenticated;
grant select on public.community_custom_roles, public.message_reports to authenticated;
alter table public.community_custom_roles enable row level security;
alter table public.message_reports enable row level security;
drop policy if exists community_roles_read_members on public.community_custom_roles;
create policy community_roles_read_members on public.community_custom_roles for select to authenticated using (public.is_community_member(community_id));
drop policy if exists message_reports_read_reporter_or_mod on public.message_reports;
create policy message_reports_read_reporter_or_mod on public.message_reports for select to authenticated
  using (reporter_id = (select auth.uid()) or public.community_has_permission(community_id, 'view_reports'));

drop policy if exists audit_read_privileged on public.audit_logs;
create policy audit_read_privileged on public.audit_logs for select to authenticated
  using (public.community_has_permission(community_id, 'view_audit'));
drop policy if exists moderation_read_privileged on public.moderation_cases;
create policy moderation_read_privileged on public.moderation_cases for select to authenticated
  using (subject_id = (select auth.uid()) or public.community_has_permission(community_id, 'moderate_members'));

drop policy if exists community_icons_manager_upload on storage.objects;
create policy community_icons_manager_upload on storage.objects for insert to authenticated
  with check (bucket_id = 'community-icons' and public.community_has_permission(((storage.foldername(name))[1])::uuid, 'manage_settings'));
drop policy if exists community_icons_manager_update on storage.objects;
create policy community_icons_manager_update on storage.objects for update to authenticated
  using (bucket_id = 'community-icons' and public.community_has_permission(((storage.foldername(name))[1])::uuid, 'manage_settings'))
  with check (bucket_id = 'community-icons' and public.community_has_permission(((storage.foldername(name))[1])::uuid, 'manage_settings'));
drop policy if exists community_icons_manager_delete on storage.objects;
create policy community_icons_manager_delete on storage.objects for delete to authenticated
  using (bucket_id = 'community-icons' and public.community_has_permission(((storage.foldername(name))[1])::uuid, 'manage_settings'));

revoke execute on function public.community_member_rank(uuid,uuid) from public, anon;
revoke execute on function public.community_has_permission(uuid,text) from public, anon;
revoke execute on function public.save_community_role(uuid,uuid,text,integer,jsonb) from public, anon;
revoke execute on function public.delete_community_role(uuid,uuid) from public, anon;
revoke execute on function public.assign_community_custom_role(uuid,uuid,uuid) from public, anon;
revoke execute on function public.report_community_message(uuid,text) from public, anon;
revoke execute on function public.resolve_community_message_report(uuid,text) from public, anon;
grant execute on function public.community_member_rank(uuid,uuid) to authenticated;
grant execute on function public.community_has_permission(uuid,text) to authenticated;
grant execute on function public.save_community_role(uuid,uuid,text,integer,jsonb) to authenticated;
grant execute on function public.delete_community_role(uuid,uuid) to authenticated;
grant execute on function public.assign_community_custom_role(uuid,uuid,uuid) to authenticated;
grant execute on function public.report_community_message(uuid,text) to authenticated;
grant execute on function public.resolve_community_message_report(uuid,text) to authenticated;
grant execute on function public.create_channel(uuid,text,public.channel_kind,public.community_role,public.community_role) to authenticated;
grant execute on function public.create_community_invite(uuid,text,timestamptz,integer) to authenticated;
grant execute on function public.update_community_settings(uuid,text,text,text,boolean,text) to authenticated;
grant execute on function public.assign_community_role(uuid,uuid,public.community_role) to authenticated;
grant execute on function public.moderate_community_member(uuid,uuid,public.moderation_action,text,integer) to authenticated;
grant execute on function public.revoke_moderation_case(uuid,text) to authenticated;
grant execute on function public.transfer_community_ownership(uuid,uuid) to authenticated;
grant execute on function public.can_join_voice_channel(uuid) to authenticated;

do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'message_reports') then
    alter publication supabase_realtime add table public.message_reports;
  end if;
end $$;
