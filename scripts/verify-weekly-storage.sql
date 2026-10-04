-- No real user is enrolled or messaged. Synthetic fixtures roll back.
begin;
do $$
declare
  v_user uuid:=gen_random_uuid(); v_chat uuid:=gen_random_uuid(); v_event uuid:=gen_random_uuid();
  v_agent uuid:=gen_random_uuid(); v_asset uuid:=gen_random_uuid(); v_reply jsonb; v_again jsonb; v_count integer;
  v_data jsonb:=jsonb_build_object('wardrobe','[]'::jsonb,'draft',null,'weekly',jsonb_build_object('enabled',true,'nextDueAt',(now()-interval '1 hour')::text));
begin
  insert into public.relay_event_inbox(event_id,agent_id,payload,message,completed_at)
    values(v_event,v_agent,'{}',jsonb_build_object('userId',v_user,'conversationId',v_chat,'text','fixture'),now());
  v_reply:=public.commit_stylist_response(v_event,v_user,v_chat,0,v_data,'Stored concept',jsonb_build_array(jsonb_build_object('attachmentId',v_asset,'mimeType','image/png')));
  v_again:=public.commit_stylist_response(v_event,v_user,v_chat,0,'{}','Different answer','[]');
  if v_reply<>v_again or v_reply->'images'->0->>'attachmentId'<>v_asset::text then raise exception 'Media replay failed'; end if;
  perform public.enqueue_due_weekly_suggestions();
  perform public.enqueue_due_weekly_suggestions();
  select count(*) into v_count from public.relay_event_inbox
    where message->>'userId'=v_user::text and message->>'deliveryKind'='weekly' and completed_at is null;
  if v_count<>1 then raise exception 'Weekly enqueue is not unique'; end if;
  if (select data->'weekly'->>'nextDueAt' from public.stylist_profiles where user_id=v_user)::timestamptz<=now() then raise exception 'Next weekly time not advanced'; end if;
  insert into public.relay_event_inbox(event_id,agent_id,payload,message,completed_at)
    values(gen_random_uuid(),v_agent,'{}',jsonb_build_object('userId',v_user,'conversationId',v_chat,'text','weekly off'),now()) returning event_id into v_event;
  v_data:=jsonb_set(v_data,'{weekly}',jsonb_build_object('enabled',false,'nextDueAt',null));
  perform public.commit_stylist_response(v_event,v_user,v_chat,2,v_data,'Paused','[]');
  select count(*) into v_count from public.relay_event_inbox
    where message->>'userId'=v_user::text and message->>'deliveryKind'='weekly' and completed_at is null;
  if v_count<>0 then raise exception 'Opt-out did not cancel queued weekly messages'; end if;
end $$;
rollback;
select 'Media replay, unique scheduling and opt-out cancellation passed; fixtures rolled back' as verification,
  (select not public from storage.buckets where id='outfit-images') as images_private,
  not has_function_privilege('anon','public.enqueue_due_weekly_suggestions()','EXECUTE') as scheduler_private;
