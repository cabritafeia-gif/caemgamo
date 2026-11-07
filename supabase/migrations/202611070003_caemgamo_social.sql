alter table public.profiles add column if not exists username text;
alter table public.profiles add column if not exists allow_friend_requests boolean not null default true;

update public.profiles as p
set username = coalesce(nullif(regexp_replace(lower(p.display_name), '[^a-z0-9]+', '_', 'g'), ''), 'user') || '_' || substr(p.id::text, 1, 8)
where p.username is null;

alter table public.profiles alter column username set not null;
create unique index if not exists profiles_username_unique on public.profiles (username);

create or replace function public.set_profile_username()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then
    new.username := old.username;
  elsif new.username is null or trim(new.username) = '' then
    new.username := coalesce(nullif(regexp_replace(lower(new.display_name), '[^a-z0-9]+', '_', 'g'), ''), 'user') || '_' || substr(new.id::text, 1, 8);
  end if;
  return new;
end;
$$;
drop trigger if exists caemgamo_profile_username on public.profiles;
create trigger caemgamo_profile_username before insert or update on public.profiles
for each row execute function public.set_profile_username();

create table if not exists public.friend_requests (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references auth.users(id) on delete cascade,
  receiver_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  check (sender_id <> receiver_id),
  unique (sender_id, receiver_id)
);
create index if not exists friend_requests_receiver_idx on public.friend_requests(receiver_id, created_at desc);

create table if not exists public.friendships (
  user_a uuid not null references auth.users(id) on delete cascade,
  user_b uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_a, user_b),
  check (user_a < user_b)
);
create index if not exists friendships_user_b_idx on public.friendships(user_b, user_a);

create table if not exists public.direct_conversations (
  id uuid primary key default gen_random_uuid(),
  user_a uuid not null references auth.users(id) on delete cascade,
  user_b uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (user_a < user_b),
  unique (user_a, user_b)
);

create table if not exists public.direct_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.direct_conversations(id) on delete cascade,
  sender_id uuid not null references auth.users(id) on delete cascade,
  content text not null check (char_length(trim(content)) between 1 and 2000),
  created_at timestamptz not null default now()
);
create index if not exists direct_messages_conversation_idx on public.direct_messages(conversation_id, created_at desc);

create or replace function public.can_access_direct_conversation(p_conversation_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.direct_conversations c
    join public.friendships f on f.user_a = c.user_a and f.user_b = c.user_b
    where c.id = p_conversation_id and auth.uid() in (c.user_a, c.user_b)
  );
$$;

create or replace function public.find_profile_by_username(p_username text)
returns table(id uuid, username text, display_name text, avatar_path text, allow_friend_requests boolean)
language sql stable security definer set search_path = '' as $$
  select p.id, p.username, p.display_name, p.avatar_path, p.allow_friend_requests
  from public.profiles p
  where auth.uid() is not null and lower(p.username) = lower(trim(p_username)) and p.id <> auth.uid()
  limit 1;
$$;

create or replace function public.send_friend_request(p_user_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare request_id uuid; user_low uuid; user_high uuid;
begin
  if auth.uid() is null then raise exception 'authentication required'; end if;
  if p_user_id is null or p_user_id = auth.uid() or not exists (select 1 from public.profiles where id = p_user_id) then raise exception 'invalid friend'; end if;
  if not exists (select 1 from public.profiles p where p.id = p_user_id and p.allow_friend_requests) then raise exception 'friend requests disabled'; end if;
  user_low := least(auth.uid(), p_user_id); user_high := greatest(auth.uid(), p_user_id);
  if exists (select 1 from public.friendships f where f.user_a = user_low and f.user_b = user_high) then raise exception 'already friends'; end if;
  if exists (select 1 from public.friend_requests r where r.sender_id = p_user_id and r.receiver_id = auth.uid()) then raise exception 'request already received'; end if;
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text, 29));
  if (select count(*) from public.friend_requests r where r.sender_id = auth.uid() and r.created_at > now() - interval '1 hour') >= 30 then raise exception 'friend_request_rate_limited'; end if;
  insert into public.friend_requests(sender_id, receiver_id) values (auth.uid(), p_user_id) returning id into request_id;
  return request_id;
end;
$$;

create or replace function public.respond_friend_request(p_request_id uuid, p_accept boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare request_row public.friend_requests%rowtype; user_low uuid; user_high uuid;
begin
  select * into request_row from public.friend_requests r where r.id = p_request_id and r.receiver_id = auth.uid() for update;
  if request_row.id is null then raise exception 'friend request not found'; end if;
  if p_accept then
    user_low := least(request_row.sender_id, request_row.receiver_id); user_high := greatest(request_row.sender_id, request_row.receiver_id);
    insert into public.friendships(user_a, user_b) values (user_low, user_high) on conflict do nothing;
  end if;
  delete from public.friend_requests where id = request_row.id;
end;
$$;

create or replace function public.cancel_friend_request(p_request_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  delete from public.friend_requests where id = p_request_id and sender_id = auth.uid();
  if not found then raise exception 'friend request not found'; end if;
end;
$$;

create or replace function public.remove_friend(p_user_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare user_low uuid; user_high uuid;
begin
  if auth.uid() is null or p_user_id = auth.uid() then raise exception 'invalid friend'; end if;
  user_low := least(auth.uid(), p_user_id); user_high := greatest(auth.uid(), p_user_id);
  delete from public.friendships where user_a = user_low and user_b = user_high;
  if not found then raise exception 'friend not found'; end if;
  delete from public.friend_requests r where (r.sender_id = auth.uid() and r.receiver_id = p_user_id) or (r.sender_id = p_user_id and r.receiver_id = auth.uid());
  delete from public.direct_conversations c where c.user_a = user_low and c.user_b = user_high;
end;
$$;

create or replace function public.open_direct_conversation(p_user_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare user_low uuid; user_high uuid; conversation_id uuid;
begin
  if auth.uid() is null or p_user_id = auth.uid() then raise exception 'invalid friend'; end if;
  user_low := least(auth.uid(), p_user_id); user_high := greatest(auth.uid(), p_user_id);
  if not exists (select 1 from public.friendships f where f.user_a = user_low and f.user_b = user_high) then raise exception 'friendship required'; end if;
  insert into public.direct_conversations(user_a, user_b) values (user_low, user_high)
  on conflict (user_a, user_b) do update set updated_at = now()
  returning id into conversation_id;
  return conversation_id;
end;
$$;

create or replace function public.touch_direct_conversation()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update public.direct_conversations set updated_at = now() where id = new.conversation_id;
  return new;
end;
$$;
drop trigger if exists caemgamo_direct_message_touch on public.direct_messages;
create trigger caemgamo_direct_message_touch after insert on public.direct_messages
for each row execute function public.touch_direct_conversation();

alter table public.friend_requests enable row level security;
alter table public.friendships enable row level security;
alter table public.direct_conversations enable row level security;
alter table public.direct_messages enable row level security;
revoke all on public.friend_requests, public.friendships, public.direct_conversations, public.direct_messages from anon, authenticated;
grant select on public.friend_requests, public.friendships, public.direct_conversations to authenticated;
grant select, insert on public.direct_messages to authenticated;
grant update (allow_friend_requests) on public.profiles to authenticated;

drop policy if exists friend_requests_read_participants on public.friend_requests;
create policy friend_requests_read_participants on public.friend_requests for select to authenticated
  using (sender_id = (select auth.uid()) or receiver_id = (select auth.uid()));
drop policy if exists friendships_read_participants on public.friendships;
create policy friendships_read_participants on public.friendships for select to authenticated
  using (user_a = (select auth.uid()) or user_b = (select auth.uid()));
drop policy if exists direct_conversations_read_participants on public.direct_conversations;
create policy direct_conversations_read_participants on public.direct_conversations for select to authenticated
  using ((user_a = (select auth.uid()) or user_b = (select auth.uid())) and public.can_access_direct_conversation(id));
drop policy if exists direct_messages_read_participants on public.direct_messages;
create policy direct_messages_read_participants on public.direct_messages for select to authenticated
  using (public.can_access_direct_conversation(conversation_id));
drop policy if exists direct_messages_insert_author on public.direct_messages;
create policy direct_messages_insert_author on public.direct_messages for insert to authenticated
  with check (sender_id = (select auth.uid()) and public.can_access_direct_conversation(conversation_id));

revoke execute on function public.can_access_direct_conversation(uuid) from public, anon;
revoke execute on function public.find_profile_by_username(text) from public, anon;
revoke execute on function public.send_friend_request(uuid) from public, anon;
revoke execute on function public.respond_friend_request(uuid,boolean) from public, anon;
revoke execute on function public.cancel_friend_request(uuid) from public, anon;
revoke execute on function public.remove_friend(uuid) from public, anon;
revoke execute on function public.open_direct_conversation(uuid) from public, anon;
grant execute on function public.can_access_direct_conversation(uuid) to authenticated;
grant execute on function public.find_profile_by_username(text) to authenticated;
grant execute on function public.send_friend_request(uuid) to authenticated;
grant execute on function public.respond_friend_request(uuid,boolean) to authenticated;
grant execute on function public.cancel_friend_request(uuid) to authenticated;
grant execute on function public.remove_friend(uuid) to authenticated;
grant execute on function public.open_direct_conversation(uuid) to authenticated;

do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'friend_requests') then
    alter publication supabase_realtime add table public.friend_requests;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'direct_messages') then
    alter publication supabase_realtime add table public.direct_messages;
  end if;
end $$;
