begin;
select plan(10);

insert into auth.users(id, email, aud, role, encrypted_password, email_confirmed_at, raw_user_meta_data)
values
 ('90000000-0000-4000-8000-000000000001','feature-owner@example.test','authenticated','authenticated','',now(),'{}'),
 ('90000000-0000-4000-8000-000000000002','feature-member@example.test','authenticated','authenticated','',now(),'{}')
on conflict (id) do nothing;
insert into public.communities(id, name, owner_id)
values ('90000000-0000-4000-8000-000000000010','Feature test','90000000-0000-4000-8000-000000000001')
on conflict (id) do nothing;
insert into public.community_members(community_id,user_id,role) values
 ('90000000-0000-4000-8000-000000000010','90000000-0000-4000-8000-000000000001','owner'),
 ('90000000-0000-4000-8000-000000000010','90000000-0000-4000-8000-000000000002','member')
on conflict (community_id,user_id) do nothing;
insert into public.channels(id,community_id,name,kind,created_by)
values ('90000000-0000-4000-8000-000000000020','90000000-0000-4000-8000-000000000010','geral','text','90000000-0000-4000-8000-000000000001')
on conflict (id) do nothing;

set local role authenticated;
select set_config('request.jwt.claim.sub','90000000-0000-4000-8000-000000000001',true);
select lives_ok(
  $$select public.save_community_role('90000000-0000-4000-8000-000000000010',null,'Conversador',2,'{"send_messages":true,"join_voice":true,"report_content":true}'::jsonb)$$,
  'owner can create a permission-scoped custom role'
);
select is(
  (select count(*)::integer from public.community_custom_roles where community_id='90000000-0000-4000-8000-000000000010' and name='Conversador'),
  1,
  'custom role is visible to community members'
);
select lives_ok(
  $$select public.assign_community_custom_role('90000000-0000-4000-8000-000000000010','90000000-0000-4000-8000-000000000002',(select id from public.community_custom_roles where community_id='90000000-0000-4000-8000-000000000010' and name='Conversador'))$$,
  'owner can assign a lower-rank custom role'
);
select is(public.community_member_rank('90000000-0000-4000-8000-000000000010','90000000-0000-4000-8000-000000000002'),2,'assigned custom role controls effective rank');
select set_config('request.jwt.claim.sub','90000000-0000-4000-8000-000000000002',true);
select ok(public.community_has_permission('90000000-0000-4000-8000-000000000010','view_reports') is false,'custom role only receives explicitly granted permissions');
select lives_ok(
  $$update public.profiles set avatar_path='preset:fox' where id=auth.uid()$$,
  'preset avatars are accepted for the signed-in user'
);

select lives_ok(
  $$insert into public.messages(channel_id,author_id,message_type,content) values ('90000000-0000-4000-8000-000000000020',auth.uid(),'gift','🎁')$$,
  'members with send permission can send a free gift'
);
select throws_ok(
  $$select public.save_community_role('90000000-0000-4000-8000-000000000010',null,'No permission',1,'{}'::jsonb)$$,
  'P0001','insufficient permission','members cannot create community roles'
);
select lives_ok(
  $$select public.report_community_message((select id from public.messages where channel_id='90000000-0000-4000-8000-000000000020' and message_type='gift' limit 1),'Please review this gift')$$,
  'members with report permission can submit a message report'
);

select set_config('request.jwt.claim.sub','90000000-0000-4000-8000-000000000001',true);
select lives_ok(
  $$select public.resolve_community_message_report((select id from public.message_reports where community_id='90000000-0000-4000-8000-000000000010' limit 1),'reviewed')$$,
  'community owner can resolve and audit a report'
);

select * from finish();
rollback;
