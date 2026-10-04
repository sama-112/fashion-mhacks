-- Preserve existing slot-zero images and allow three cached previews per inbox event.
begin;
alter table public.stylist_image_assets add column if not exists slot smallint not null default 0 check (slot between 0 and 2);
alter table public.stylist_image_assets drop constraint if exists stylist_image_assets_pkey;
alter table public.stylist_image_assets add primary key (event_id,slot);

-- Freeze the exact pathway/outfit plan before generating any image, so retries cannot
-- combine cached pictures with a newly generated text plan or different garment IDs.
create table if not exists public.stylist_image_turns (
  event_id uuid primary key references public.relay_event_inbox(event_id),
  user_id uuid not null,
  conversation_id uuid not null,
  turn jsonb not null,
  created_at timestamptz not null default now()
);
alter table public.stylist_image_turns enable row level security;
revoke all on public.stylist_image_turns from public,anon,authenticated;
grant select,insert on public.stylist_image_turns to service_role;

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
  if jsonb_typeof(p_reply_media) is distinct from 'array' or jsonb_array_length(p_reply_media)>3 then
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
commit;
