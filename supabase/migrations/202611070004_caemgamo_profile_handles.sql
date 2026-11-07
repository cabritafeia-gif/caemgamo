-- Let each signed-in user update their own public friend handle safely.
create or replace function public.set_profile_username()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then
    if new.username is distinct from old.username then
      if auth.uid() is null or auth.uid() <> new.id then
        raise exception 'profile handle can only be changed by its owner';
      end if;
      new.username := lower(trim(new.username));
      if new.username !~ '^[a-z0-9][a-z0-9_]{2,31}$' then
        raise exception 'invalid profile handle';
      end if;
    else
      new.username := old.username;
    end if;
  elsif new.username is null or trim(new.username) = '' then
    new.username := coalesce(nullif(regexp_replace(lower(new.display_name), '[^a-z0-9]+', '_', 'g'), ''), 'user') || '_' || substr(new.id::text, 1, 8);
  end if;
  return new;
end;
$$;

grant update (username) on public.profiles to authenticated;
