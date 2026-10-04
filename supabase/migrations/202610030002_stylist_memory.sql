-- Private, per-user/per-chat wardrobe drafts, confirmed clothes and style pathways.
create table if not exists public.stylist_profiles (
  user_id uuid not null,
  conversation_id uuid not null,
  data jsonb not null default '{}'::jsonb check (jsonb_typeof(data) = 'object'),
  version integer not null default 0 check (version >= 0),
  updated_at timestamptz not null default now(),
  primary key (user_id, conversation_id)
);
alter table public.stylist_profiles enable row level security;
revoke all on public.stylist_profiles from public, anon, authenticated;
grant select, insert, update on public.stylist_profiles to service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('wardrobe-videos', 'wardrobe-videos', false, 52428800,
  array['video/mp4', 'video/quicktime', 'video/webm'])
on conflict (id) do nothing;

-- Commit state and its exact reply together. A retry cannot apply the same
-- wardrobe edit or pathway feedback twice after a process restart.
create or replace function public.commit_stylist_turn(
  p_event_id uuid, p_user_id uuid, p_conversation_id uuid,
  p_expected_version integer, p_data jsonb, p_reply_text text
) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_event public.relay_event_inbox%rowtype;
  v_version integer;
begin
  select * into v_event from public.relay_event_inbox
    where event_id = p_event_id for update;
  if not found or v_event.message->>'userId' is distinct from p_user_id::text
    or v_event.message->>'conversationId' is distinct from p_conversation_id::text then
    raise exception 'Stylist event identity mismatch';
  end if;
  if v_event.reply_text is not null then return v_event.reply_text; end if;
  if jsonb_typeof(p_data) is distinct from 'object'
    or p_reply_text is null or length(btrim(p_reply_text)) = 0 then
    raise exception 'Invalid stylist turn';
  end if;
  insert into public.stylist_profiles (user_id, conversation_id)
    values (p_user_id, p_conversation_id) on conflict do nothing;
  select version into v_version from public.stylist_profiles
    where user_id = p_user_id and conversation_id = p_conversation_id for update;
  if v_version <> p_expected_version then raise exception 'Stylist state changed; retry turn'; end if;
  update public.stylist_profiles set data = p_data, version = version + 1, updated_at = now()
    where user_id = p_user_id and conversation_id = p_conversation_id;
  update public.relay_event_inbox set reply_text = p_reply_text where event_id = p_event_id;
  return p_reply_text;
end;
$$;
revoke all on function public.commit_stylist_turn(uuid,uuid,uuid,integer,jsonb,text) from public, anon, authenticated;
grant execute on function public.commit_stylist_turn(uuid,uuid,uuid,integer,jsonb,text) to service_role;
