-- Run in Supabase SQL Editor. Synthetic writes are rolled back together.
begin;
do $$
declare
  u uuid := gen_random_uuid();
  c uuid := gen_random_uuid();
  e1 uuid := gen_random_uuid();
  e2 uuid := gen_random_uuid();
  a uuid := gen_random_uuid();
  answer text;
  current_version integer;
begin
  insert into public.relay_event_inbox(event_id,agent_id,payload,message,completed_at)
  values
    (e1,a,'{}',jsonb_build_object('userId',u,'conversationId',c,'text','storage fixture'),now()),
    (e2,a,'{}',jsonb_build_object('userId',u,'conversationId',c,'text','storage fixture'),now());
  answer := public.commit_stylist_turn(e1,u,c,0,'{"wardrobe":[],"draft":null}', 'fixture saved');
  if answer <> 'fixture saved' then raise exception 'Commit failed'; end if;
  answer := public.commit_stylist_turn(e1,u,c,0,'{"wardrobe":[]}', 'different retry');
  if answer <> 'fixture saved' then raise exception 'Replay changed reply'; end if;
  select version into current_version from public.stylist_profiles where user_id=u and conversation_id=c;
  if current_version <> 1 then raise exception 'Replay applied twice'; end if;
  begin
    perform public.commit_stylist_turn(e2,u,c,0,'{}','stale');
    raise exception 'Stale version accepted';
  exception when others then
    if sqlerrm <> 'Stylist state changed; retry turn' then raise; end if;
  end;
  begin
    perform public.commit_stylist_turn(e2,gen_random_uuid(),c,1,'{}','wrong user');
    raise exception 'Cross-user state accepted';
  exception when others then
    if sqlerrm <> 'Stylist event identity mismatch' then raise; end if;
  end;
end;
$$;
rollback;
select
  to_regclass('public.stylist_profiles') is not null as profiles_ready,
  not (select public from storage.buckets where id='wardrobe-videos') as videos_private,
  not has_function_privilege('anon','public.commit_stylist_turn(uuid,uuid,uuid,integer,jsonb,text)','execute') as anonymous_access_blocked,
  'Atomic commit, replay, version and identity checks passed; fixture rolled back' as verification;
