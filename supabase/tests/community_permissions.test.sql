begin;
select plan(12);

insert into auth.users(id, email, aud, role, encrypted_password, email_confirmed_at, raw_user_meta_data)
values
 ('00000000-0000-4000-8000-000000000001','owner@example.test','authenticated','authenticated','',now(),'{}'),
 ('00000000-0000-4000-8000-000000000002','admin@example.test','authenticated','authenticated','',now(),'{}'),
 ('00000000-0000-4000-8000-000000000003','mod@example.test','authenticated','authenticated','',now(),'{}'),
 ('00000000-0000-4000-8000-000000000004','member@example.test','authenticated','authenticated','',now(),'{}')
on conflict (id) do nothing;

insert into public.communities(id, name, owner_id)
values ('10000000-0000-4000-8000-000000000001','Permission test','00000000-0000-4000-8000-000000000001')
on conflict (id) do nothing;
insert into public.community_members(community_id,user_id,role) values
 ('10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','owner'),
 ('10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','admin'),
 ('10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000003','mod'),
 ('10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000004','member')
on conflict (community_id,user_id) do nothing;
insert into public.channels(id,community_id,name,kind,created_by)
values ('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','geral','text','00000000-0000-4000-8000-000000000001')
on conflict (id) do nothing;

set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000004',true);
select ok(exists(select 1 from public.profiles where id = auth.uid()), 'signup creates a profile');
select lives_ok($$update public.profiles set display_name='Test member', preferred_theme='navy' where id=auth.uid()$$, 'users can update their own profile');
select throws_ok(
  $$select public.moderate_community_member('10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000003','warning','abuse',null)$$,
  'P0001','insufficient permission','ordinary members cannot moderate'
);
select throws_ok(
  $$select public.assign_community_role('10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000004','admin')$$,
  'P0001','insufficient permission','ordinary members cannot assign roles'
);

select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000003',true);
select throws_ok(
  $$select public.moderate_community_member('10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','warning','overreach',null)$$,
  'P0001','cannot moderate equal or higher role','moderators cannot punish admins'
);
select lives_ok(
  $$select public.moderate_community_member('10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000004','mute','temporary mute',3600)$$,
  'moderators can mute lower roles'
);
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000004',true);
select throws_ok(
  $$insert into public.messages(channel_id,author_id,content) values ('20000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000004','muted message')$$,
  '42501',null,'mute blocks message posting'
);

reset role;
update public.moderation_cases set expires_at = now() - interval '1 minute'
where community_id='10000000-0000-4000-8000-000000000001' and subject_id='00000000-0000-4000-8000-000000000004' and action='mute';
set local role authenticated;
select lives_ok(
  $$insert into public.messages(channel_id,author_id,content) values ('20000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000004','mute expired')$$,
  'expired mute no longer blocks chat'
);
select lives_ok(
  $$insert into public.messages(channel_id,author_id,content) values
    ('20000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000004','rate 2'),
    ('20000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000004','rate 3'),
    ('20000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000004','rate 4'),
    ('20000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000004','rate 5')$$,
  'up to five messages per ten seconds are accepted'
);
select throws_ok(
  $$insert into public.messages(channel_id,author_id,content) values ('20000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000004','rate 6')$$,
  'P0001','message_rate_limited','sixth message in ten seconds is rejected'
);

select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000003',true);
select lives_ok(
  $$select public.moderate_community_member('10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000004','ban','temporary ban',60)$$,
  'moderators can ban lower roles'
);
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000004',true);
select ok(not public.is_community_member('10000000-0000-4000-8000-000000000001'), 'active ban denies community membership');

select * from finish();
rollback;
