begin;
select plan(17);

insert into auth.users(id, email, aud, role, encrypted_password, email_confirmed_at, raw_user_meta_data)
values
 ('91000000-0000-4000-8000-000000000001','social-a@example.test','authenticated','authenticated','',now(),'{"display_name":"Pessoa A"}'),
 ('91000000-0000-4000-8000-000000000002','social-b@example.test','authenticated','authenticated','',now(),'{"display_name":"Pessoa B"}'),
 ('91000000-0000-4000-8000-000000000003','social-c@example.test','authenticated','authenticated','',now(),'{"display_name":"Pessoa C"}')
on conflict (id) do nothing;

set local role authenticated;
select set_config('request.jwt.claim.sub','91000000-0000-4000-8000-000000000003',true);
select lives_ok($$update public.profiles set allow_friend_requests=false where id=auth.uid()$$,'user can save their own friend-request privacy preference');
select set_config('request.jwt.claim.sub','91000000-0000-4000-8000-000000000001',true);
select throws_ok(
  $$select public.send_friend_request('91000000-0000-4000-8000-000000000003')$$,
  'P0001','friend requests disabled','backend blocks requests when the recipient disabled them'
);
select is(
  (select count(*)::integer from public.find_profile_by_username((select username from public.profiles where id='91000000-0000-4000-8000-000000000002'))),
  1,
  'signed-in user can find another person by exact public handle'
);
select lives_ok(
  $$select public.send_friend_request('91000000-0000-4000-8000-000000000002')$$,
  'sender can create a friend request through the authorized function'
);

select set_config('request.jwt.claim.sub','91000000-0000-4000-8000-000000000002',true);
select is((select count(*)::integer from public.friend_requests where receiver_id=auth.uid()),1,'receiver can read their incoming request');
select lives_ok(
  $$select public.respond_friend_request((select id from public.friend_requests where receiver_id=auth.uid()),true)$$,
  'receiver can accept an incoming friend request'
);
select is((select count(*)::integer from public.friendships where user_a=least(auth.uid(),'91000000-0000-4000-8000-000000000001'::uuid) and user_b=greatest(auth.uid(),'91000000-0000-4000-8000-000000000001'::uuid)),1,'accepted request creates a friendship visible to its members');
select lives_ok(
  $$select public.open_direct_conversation('91000000-0000-4000-8000-000000000001')$$,
  'friends can open a private direct conversation'
);
select set_config('test.conversation_id',(select id::text from public.direct_conversations where user_a='91000000-0000-4000-8000-000000000001' and user_b='91000000-0000-4000-8000-000000000002'),true);
select lives_ok(
  $$insert into public.direct_messages(conversation_id,sender_id,content) select id,auth.uid(),'private hello' from public.direct_conversations where user_a='91000000-0000-4000-8000-000000000001' and user_b='91000000-0000-4000-8000-000000000002'$$,
  'friend can send a message as their own account'
);
select is((select count(*)::integer from public.direct_messages),1,'participant can read the private message');

select set_config('request.jwt.claim.sub','91000000-0000-4000-8000-000000000003',true);
select is((select count(*)::integer from public.direct_messages),0,'unrelated user cannot read a private conversation');
select throws_ok(
  $$insert into public.direct_messages(conversation_id,sender_id,content) values (current_setting('test.conversation_id')::uuid,auth.uid(),'intrusion')$$,
  '42501',
  'new row violates row-level security policy for table "direct_messages"',
  'unrelated user cannot send a message into a private conversation'
);

select set_config('request.jwt.claim.sub','91000000-0000-4000-8000-000000000001',true);
select lives_ok($$update public.profiles set display_name='Pessoa A atualizada' where id=auth.uid()$$,'user can update their own profile');
select lives_ok($$update public.profiles set username='pessoa_a_atualizada' where id=auth.uid()$$,'user can change their own friend handle');
select is((select username from public.profiles where id=auth.uid()),'pessoa_a_atualizada','new public handle is saved');
select set_config('request.jwt.claim.sub','91000000-0000-4000-8000-000000000002',true);
select is(
  (with changed as (update public.profiles set username='stolen_handle' where id='91000000-0000-4000-8000-000000000001' returning id) select count(*)::integer from changed),
  0,
  'another account cannot change a user handle'
);
reset role;
select set_config('request.jwt.claim.sub','',true);
select throws_ok(
  $$update public.profiles set username='stolen_handle' where id='91000000-0000-4000-8000-000000000001'$$,
  'P0001','profile handle can only be changed by its owner','privileged updates cannot impersonate a user handle change'
);
select is((select username from public.profiles where id='91000000-0000-4000-8000-000000000001'),'pessoa_a_atualizada','failed privileged update leaves the handle unchanged');

select * from finish();
rollback;
