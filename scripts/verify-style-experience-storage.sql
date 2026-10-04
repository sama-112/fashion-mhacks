-- Synthetic fixtures only; the transaction rolls back without touching real profiles.
begin;
set local role service_role;
do $$
declare
  v_user uuid:=gen_random_uuid(); v_chat uuid:=gen_random_uuid();
  v_event uuid:=gen_random_uuid(); v_other uuid:=gen_random_uuid(); v_agent uuid:=gen_random_uuid();
  v_media jsonb:=jsonb_build_array(
    jsonb_build_object('attachmentId',gen_random_uuid(),'mimeType','image/png'),
    jsonb_build_object('attachmentId',gen_random_uuid(),'mimeType','image/png'),
    jsonb_build_object('attachmentId',gen_random_uuid(),'mimeType','image/png'));
  v_reply jsonb; v_again jsonb;
begin
  insert into public.relay_event_inbox(event_id,agent_id,payload,message,completed_at)
    values(v_event,v_agent,'{}',jsonb_build_object('userId',v_user,'conversationId',v_chat,'text','synthetic'),now()),
    (v_other,v_agent,'{}',jsonb_build_object('userId',v_user,'conversationId',v_chat,'text','synthetic'),now());
  insert into public.stylist_image_assets(event_id,slot,user_id,conversation_id,storage_path)
    select v_event,n,v_user,v_chat,'synthetic/'||n from generate_series(0,2) n;
  insert into public.stylist_image_turns(event_id,user_id,conversation_id,turn)
    values(v_event,v_user,v_chat,'{"text":"Three previews","outfits":[]}') on conflict(event_id) do nothing;
  insert into public.stylist_image_turns(event_id,user_id,conversation_id,turn)
    values(v_event,v_user,v_chat,'{"text":"Wrong replacement"}') on conflict(event_id) do nothing;
  if (select turn->>'text' from public.stylist_image_turns where event_id=v_event)<>'Three previews' then
    raise exception 'Image plan changed on retry';
  end if;
  v_reply:=public.commit_stylist_response(v_event,v_user,v_chat,0,'{"wardrobe":[],"weekly":{"enabled":false}}','Three previews',v_media);
  v_again:=public.commit_stylist_response(v_event,v_user,v_chat,0,'{}','Wrong replacement','[]');
  if v_reply<>v_again or jsonb_array_length(v_reply->'images')<>3 then raise exception 'Three-image replay failed'; end if;
  if (select version from public.stylist_profiles where user_id=v_user and conversation_id=v_chat)<>1 then raise exception 'Profile applied twice'; end if;
  begin
    perform public.commit_stylist_response(v_other,gen_random_uuid(),v_chat,0,'{}','Wrong user',v_media);
    raise exception 'Wrong identity was accepted';
  exception when others then
    if sqlerrm<>'Stylist event identity mismatch' then raise; end if;
  end;
  begin
    perform public.commit_stylist_response(v_other,v_user,v_chat,1,'{}','Too many',v_media||jsonb_build_array(v_media->0));
    raise exception 'Four images were accepted';
  exception when others then
    if sqlerrm<>'Invalid reply media' then raise; end if;
  end;
end $$;
rollback;
select 'Three slots, frozen plans, atomic replay and validation passed; fixtures rolled back' as verification,
  not has_table_privilege('anon','public.stylist_image_turns','SELECT') as plans_private;
