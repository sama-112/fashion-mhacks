-- Private image artifacts and durable proactive delivery. Reuses the existing inbox worker.
alter table public.relay_event_inbox add column if not exists reply_media jsonb not null default '[]'::jsonb;
alter table public.relay_event_inbox add column if not exists delivery_key text;
create unique index if not exists relay_inbox_delivery_key on public.relay_event_inbox(delivery_key) where delivery_key is not null;

create table if not exists public.stylist_image_assets (
  event_id uuid primary key references public.relay_event_inbox(event_id),
  user_id uuid not null,
  conversation_id uuid not null,
  storage_path text not null,
  attachment jsonb,
  created_at timestamptz not null default now()
);
alter table public.stylist_image_assets enable row level security;
revoke all on public.stylist_image_assets from public, anon, authenticated;
grant select, insert, update on public.stylist_image_assets to service_role;
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values ('outfit-images','outfit-images',false,10485760,array['image/png','image/jpeg','image/webp'])
on conflict(id) do nothing;

-- Exact text, media attachment IDs, and profile changes commit together.
create or replace function public.commit_stylist_response(
  p_event_id uuid, p_user_id uuid, p_conversation_id uuid,
  p_expected_version integer, p_data jsonb, p_reply_text text, p_reply_media jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_event public.relay_event_inbox%rowtype; v_text text;
begin
  select * into v_event from public.relay_event_inbox where event_id=p_event_id for update;
  if not found or v_event.message->>'userId' is distinct from p_user_id::text
    or v_event.message->>'conversationId' is distinct from p_conversation_id::text then
    raise exception 'Stylist event identity mismatch';
  end if;
  if v_event.reply_text is not null then
    return jsonb_build_object('text',v_event.reply_text,'images',v_event.reply_media);
  end if;
  if jsonb_typeof(p_reply_media) is distinct from 'array' or jsonb_array_length(p_reply_media)>1 then
    raise exception 'Invalid reply media';
  end if;
  if exists(select 1 from jsonb_array_elements(p_reply_media) part
      where part->>'attachmentId' !~ '^[0-9a-f-]{36}$'
        or part->>'attachmentId' is null
        or part->>'mimeType' not in ('image/png','image/jpeg','image/webp') or part->>'mimeType' is null) then
    raise exception 'Invalid reply attachment';
  end if;
  v_text := public.commit_stylist_turn(p_event_id,p_user_id,p_conversation_id,p_expected_version,p_data,p_reply_text);
  update public.relay_event_inbox set reply_media=p_reply_media where event_id=p_event_id;
  -- Opting out cancels already queued unsent weekly batches as part of the same turn.
  if coalesce((p_data->'weekly'->>'enabled')::boolean,false)=false then
    update public.relay_event_inbox set completed_at=now()
    where completed_at is null and message->>'deliveryKind'='weekly'
      and message->>'userId'=p_user_id::text and message->>'conversationId'=p_conversation_id::text
      and event_id<>p_event_id;
  end if;
  return jsonb_build_object('text',v_text,'images',p_reply_media);
end $$;
revoke all on function public.commit_stylist_response(uuid,uuid,uuid,integer,jsonb,text,jsonb) from public,anon,authenticated;
grant execute on function public.commit_stylist_response(uuid,uuid,uuid,integer,jsonb,text,jsonb) to service_role;

create or replace function public.enqueue_due_weekly_suggestions()
returns integer language plpgsql security definer set search_path = '' as $$
declare v_profile public.stylist_profiles%rowtype; v_agent uuid; v_count integer:=0; v_due timestamptz;
begin
  for v_profile in select * from public.stylist_profiles
    where data->'weekly'->>'enabled'='true'
      and data->'weekly'->>'nextDueAt' is not null
      and (data->'weekly'->>'nextDueAt')::timestamptz<=now()
      and (data->'draft' is null or data->'draft'='null'::jsonb)
    order by updated_at limit 10 for update skip locked
  loop
    v_due := (v_profile.data->'weekly'->>'nextDueAt')::timestamptz;
    select agent_id into v_agent from public.relay_event_inbox
      where message->>'userId'=v_profile.user_id::text and message->>'conversationId'=v_profile.conversation_id::text
      order by received_at desc limit 1;
    if v_agent is null then continue; end if;
    insert into public.relay_event_inbox(event_id,agent_id,payload,message,delivery_key)
      values(gen_random_uuid(),v_agent,jsonb_build_object('source','weekly-scheduler'),
        jsonb_build_object('userId',v_profile.user_id,'conversationId',v_profile.conversation_id,'text','Weekly clothing suggestions','deliveryKind','weekly'),
        'weekly:'||v_profile.user_id::text||':'||v_profile.conversation_id::text||':'||v_due::text)
      on conflict(delivery_key) where delivery_key is not null do nothing;
    if found then v_count:=v_count+1; end if;
    -- Offline catch-up sends one current batch and schedules the next seven days later.
    update public.stylist_profiles set
      data=jsonb_set(data,'{weekly,nextDueAt}',to_jsonb((now()+interval '7 days')::text)),
      version=version+1,updated_at=now()
      where user_id=v_profile.user_id and conversation_id=v_profile.conversation_id;
  end loop;
  return v_count;
end $$;
revoke all on function public.enqueue_due_weekly_suggestions() from public,anon,authenticated;
grant execute on function public.enqueue_due_weekly_suggestions() to service_role;
