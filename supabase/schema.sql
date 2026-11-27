  create table if not exists public.profiles (
    id uuid primary key references auth.users (id) on delete cascade,
    name text not null check (char_length(name) between 1 and 40),
    phone text not null unique check (phone ~ '^[0-9]{10}$'),
    email text,
    account_number text unique check (account_number ~ '^[0-9]{8}$'),
    created_at timestamptz not null default now()
  );

  alter table public.profiles add column if not exists email text;
  alter table public.profiles alter column account_number drop not null;
  alter table public.profiles add column if not exists is_premium boolean not null default false;
  alter table public.profiles add column if not exists premium_until timestamptz;

  create unique index if not exists profiles_email_lower_unique_idx
    on public.profiles (pg_catalog.lower(email))
    where email is not null;

  create table if not exists public.messages (
    id uuid primary key default gen_random_uuid(),
    sender_id uuid not null references public.profiles (id) on delete cascade,
    recipient_id uuid not null references public.profiles (id) on delete cascade,
    text text,
    created_at timestamptz not null default now(),
    read_at timestamptz,
    updated_at timestamptz,
    deleted_at timestamptz,
    attachment_path text,
    attachment_name text,
    attachment_mime text,
    attachment_size bigint,
    constraint messages_no_self_chat check (sender_id <> recipient_id)
  );

  alter table public.messages add column if not exists updated_at timestamptz;
  alter table public.messages add column if not exists deleted_at timestamptz;
  alter table public.messages add column if not exists attachment_path text;
  alter table public.messages add column if not exists attachment_name text;
  alter table public.messages add column if not exists attachment_mime text;
  alter table public.messages add column if not exists attachment_size bigint;
  alter table public.messages alter column text drop not null;
  alter table public.messages drop constraint if exists messages_text_check;
  alter table public.messages
    add constraint messages_text_check
    check (text is null or char_length(btrim(text)) between 1 and 2000);
  alter table public.messages drop constraint if exists messages_content_check;
  alter table public.messages
    add constraint messages_content_check
    check (deleted_at is not null or nullif(btrim(text), '') is not null or attachment_path is not null);
  alter table public.messages drop constraint if exists messages_attachment_metadata_check;
  alter table public.messages
    add constraint messages_attachment_metadata_check
    check (
      (attachment_path is null and attachment_name is null and attachment_mime is null and attachment_size is null)
      or (
        attachment_path is not null
        and attachment_name is not null
        and attachment_mime is not null
        and attachment_mime in ('image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'video/webm', 'video/quicktime', 'audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg')
        and attachment_size is not null
        and attachment_size between 1 and 26214400
      )
    );

  create index if not exists messages_sender_created_idx
    on public.messages (sender_id, created_at desc);
  create index if not exists messages_recipient_created_idx
    on public.messages (recipient_id, created_at desc);
  create index if not exists messages_unread_idx
    on public.messages (recipient_id, sender_id)
    where read_at is null;

  create table if not exists public.profile_lookup_attempts (
    user_id uuid not null references auth.users (id) on delete cascade,
    attempted_at timestamptz not null default now()
  );

  create table if not exists public.chat_archives (
    user_id uuid not null references auth.users (id) on delete cascade,
    peer_id uuid not null references public.profiles (id) on delete cascade,
    archived_at timestamptz not null default now(),
    primary key (user_id, peer_id),
    constraint chat_archives_no_self check (user_id <> peer_id)
  );

  create table if not exists public.hidden_chats (
    user_id uuid not null references auth.users (id) on delete cascade,
    peer_id uuid not null references public.profiles (id) on delete cascade,
    hidden_at timestamptz not null default now(),
    primary key (user_id, peer_id),
    constraint hidden_chats_no_self check (user_id <> peer_id)
  );

  create table if not exists public.chat_clears (
    user_id uuid not null references auth.users (id) on delete cascade,
    peer_id uuid not null references public.profiles (id) on delete cascade,
    cleared_at timestamptz not null default now(),
    primary key (user_id, peer_id),
    constraint chat_clears_no_self check (user_id <> peer_id)
  );

  create table if not exists public.user_presence (
    user_id uuid primary key references auth.users (id) on delete cascade,
    last_seen_at timestamptz not null default now()
  );

  create table if not exists public.communities (
    id uuid primary key default gen_random_uuid(),
    name text not null check (char_length(btrim(name)) between 1 and 60),
    created_by uuid not null references public.profiles (id) on delete cascade,
    created_at timestamptz not null default now()
  );

  create table if not exists public.community_members (
    community_id uuid not null references public.communities (id) on delete cascade,
    user_id uuid not null references public.profiles (id) on delete cascade,
    role text not null default 'member' check (role in ('owner', 'admin', 'member')),
    added_by uuid not null references public.profiles (id) on delete cascade,
    created_at timestamptz not null default now(),
    primary key (community_id, user_id)
  );

  create table if not exists public.community_groups (
    id uuid primary key default gen_random_uuid(),
    community_id uuid not null references public.communities (id) on delete cascade,
    name text not null check (char_length(btrim(name)) between 1 and 60),
    created_by uuid not null references public.profiles (id) on delete cascade,
    created_at timestamptz not null default now()
  );

  create index if not exists community_groups_community_created_idx
    on public.community_groups (community_id, created_at);

  create table if not exists public.group_messages (
    id uuid primary key default gen_random_uuid(),
    group_id uuid not null references public.community_groups (id) on delete cascade,
    sender_id uuid not null references public.profiles (id) on delete cascade,
    text text,
    created_at timestamptz not null default now(),
    updated_at timestamptz,
    deleted_at timestamptz,
    attachment_path text,
    attachment_name text,
    attachment_mime text,
    attachment_size bigint,
    constraint group_messages_text_check
      check (text is null or char_length(btrim(text)) between 1 and 2000),
    constraint group_messages_content_check
      check (deleted_at is not null or nullif(btrim(text), '') is not null or attachment_path is not null),
    constraint group_messages_attachment_metadata_check
      check (
        (attachment_path is null and attachment_name is null and attachment_mime is null and attachment_size is null)
        or (
          attachment_path is not null
          and attachment_name is not null
          and attachment_mime is not null
          and attachment_mime in ('image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'video/webm', 'video/quicktime', 'audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg')
          and attachment_size is not null
          and attachment_size between 1 and 26214400
        )
      )
  );

  create index if not exists group_messages_group_created_idx
    on public.group_messages (group_id, created_at desc);

  create table if not exists public.call_sessions (
    id uuid primary key default gen_random_uuid(),
    caller_id uuid not null references public.profiles (id) on delete cascade,
    callee_id uuid not null references public.profiles (id) on delete cascade,
    media_type text not null check (media_type in ('audio', 'video')),
    created_at timestamptz not null default now(),
    constraint call_sessions_no_self_call check (caller_id <> callee_id)
  );

  create index if not exists call_sessions_callee_created_idx
    on public.call_sessions (callee_id, created_at desc);

  create table if not exists public.call_signals (
    id uuid primary key default gen_random_uuid(),
    call_id uuid not null references public.call_sessions (id) on delete cascade,
    sender_id uuid not null references public.profiles (id) on delete cascade,
    signal_type text not null check (signal_type in ('offer', 'answer', 'candidate', 'accept', 'reject', 'end')),
    payload jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    constraint call_signals_payload_size check (pg_catalog.octet_length(payload::text) between 2 and 20000)
  );

  create index if not exists call_signals_call_created_idx
    on public.call_signals (call_id, created_at);

  create table if not exists public.push_subscriptions (
    id uuid primary key default gen_random_uuid(),
    endpoint text not null,
    user_id uuid not null references public.profiles (id) on delete cascade,
    platform text not null default 'web' check (platform in ('web', 'fcm')),
    p256dh text,
    auth text,
    updated_at timestamptz not null default now(),
    constraint push_subscriptions_user_endpoint_unique unique (user_id, endpoint),
    constraint push_subscriptions_web_keys_required check (platform <> 'web' or (p256dh is not null and auth is not null))
  );

  create index if not exists push_subscriptions_user_idx
    on public.push_subscriptions (user_id);

  create table if not exists public.premium_requests (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references public.profiles (id) on delete cascade,
    plan_months integer not null check (plan_months in (3, 5, 12, 24, 36)),
    amount_rs integer not null check (amount_rs in (3, 5, 12, 24, 20)),
    status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
    payment_reference text not null,
    created_at timestamptz not null default now(),
    reviewed_at timestamptz
  );
  create index if not exists premium_requests_status_created_idx on public.premium_requests (status, created_at desc);
  alter table public.premium_requests enable row level security;
  drop policy if exists "Users can view their premium requests" on public.premium_requests;
  create policy "Users can view their premium requests" on public.premium_requests for select to authenticated using (user_id = (select auth.uid()));

  create table if not exists public.premium_payment_settings (
    id boolean primary key default true check (id),
    upi_id text not null default '',
    qr_image_url text not null default '',
    updated_at timestamptz not null default now()
  );
  insert into public.premium_payment_settings (id) values (true) on conflict (id) do nothing;
  alter table public.premium_payment_settings enable row level security;
  drop policy if exists "Authenticated users can read premium payment details" on public.premium_payment_settings;
  create policy "Authenticated users can read premium payment details" on public.premium_payment_settings for select to authenticated using (true);

  create table if not exists public.admin_media_cleanup (
    owner_id uuid not null references auth.users (id) on delete cascade,
    target_user_id uuid not null references auth.users (id) on delete cascade,
    storage_path text not null,
    created_at timestamptz not null default now(),
    primary key (owner_id, target_user_id, storage_path)
  );
  alter table public.admin_media_cleanup enable row level security;
  revoke all on public.admin_media_cleanup from anon, authenticated;

  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values (
    'mingle-chat-media',
    'mingle-chat-media',
    false,
    26214400,
    array['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'video/webm', 'video/quicktime', 'audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg']
  )
  on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

  create index if not exists profile_lookup_attempts_user_time_idx
    on public.profile_lookup_attempts (user_id, attempted_at);

  create or replace function public.is_community_member(p_community_id uuid)
  returns boolean
  language sql
  stable
  security definer
  set search_path = ''
  as $$
    select auth.uid() is not null and exists (
      select 1
      from public.community_members as member
      where member.community_id = p_community_id
        and member.user_id = auth.uid()
    );
  $$;

  create or replace function public.can_upload_chat_media(p_target_id text)
  returns boolean
  language sql
  stable
  security definer
  set search_path = ''
  as $$
    select auth.uid() is not null and (
      exists (
        select 1
        from public.profiles as recipient
        where recipient.id::text = p_target_id
          and recipient.id <> auth.uid()
      )
      or exists (
        select 1
        from public.community_groups as group_chat
        where group_chat.id::text = p_target_id
          and public.is_community_member(group_chat.community_id)
      )
    );
  $$;

  alter table public.profiles enable row level security;
  alter table public.messages enable row level security;
  alter table public.profile_lookup_attempts enable row level security;
  alter table public.chat_archives enable row level security;
  alter table public.hidden_chats enable row level security;
  alter table public.chat_clears enable row level security;
  alter table public.user_presence enable row level security;
  alter table public.communities enable row level security;
  alter table public.community_members enable row level security;
  alter table public.community_groups enable row level security;
  alter table public.group_messages enable row level security;
  alter table public.call_sessions enable row level security;
  alter table public.call_signals enable row level security;
  alter table public.push_subscriptions enable row level security;

  drop policy if exists "Users can view their own profile" on public.profiles;
  create policy "Users can view their own profile"
    on public.profiles for select to authenticated
    using ((select auth.uid()) = id);

  drop policy if exists "Chat participants can read messages" on public.messages;
  create policy "Chat participants can read messages"
    on public.messages for select to authenticated
    using ((select auth.uid()) = sender_id or (select auth.uid()) = recipient_id);

  drop policy if exists "Users can send messages to other accounts" on public.messages;
  create policy "Users can send messages to other accounts"
    on public.messages for insert to authenticated
    with check (
      (select auth.uid()) = sender_id
      and (select auth.uid()) <> recipient_id
    );

  drop policy if exists "Recipients can mark messages as read" on public.messages;
  create policy "Recipients can mark messages as read"
    on public.messages for update to authenticated
    using ((select auth.uid()) = recipient_id and read_at is null)
    with check ((select auth.uid()) = recipient_id and read_at is not null);

  drop policy if exists "Users can view their archived chats" on public.chat_archives;
  create policy "Users can view their archived chats"
    on public.chat_archives for select to authenticated
    using ((select auth.uid()) = user_id);

  drop policy if exists "Users can archive their chats" on public.chat_archives;
  create policy "Users can archive their chats"
    on public.chat_archives for insert to authenticated
    with check ((select auth.uid()) = user_id and user_id <> peer_id);

  drop policy if exists "Users can unarchive their chats" on public.chat_archives;
  create policy "Users can unarchive their chats"
    on public.chat_archives for delete to authenticated
    using ((select auth.uid()) = user_id);

  drop policy if exists "Users can manage hidden chats" on public.hidden_chats;
  create policy "Users can manage hidden chats"
    on public.hidden_chats for all to authenticated
    using ((select auth.uid()) = user_id)
    with check ((select auth.uid()) = user_id and user_id <> peer_id);

  drop policy if exists "Users can manage chat clears" on public.chat_clears;
  create policy "Users can manage chat clears"
    on public.chat_clears for all to authenticated
    using ((select auth.uid()) = user_id)
    with check ((select auth.uid()) = user_id and user_id <> peer_id);

  drop policy if exists "Users can view online presence" on public.user_presence;
  create policy "Users can view online presence"
    on public.user_presence for select to authenticated
    using (true);

  drop policy if exists "Users can update their own presence" on public.user_presence;
  create policy "Users can update their own presence"
    on public.user_presence for all to authenticated
    using ((select auth.uid()) = user_id)
    with check ((select auth.uid()) = user_id);

  drop policy if exists "Community members can view their communities" on public.communities;
  create policy "Community members can view their communities"
    on public.communities for select to authenticated
    using (public.is_community_member(id));

  drop policy if exists "Community members can view their membership" on public.community_members;
  create policy "Community members can view their membership"
    on public.community_members for select to authenticated
    using (user_id = (select auth.uid()));

  drop policy if exists "Community members can view groups" on public.community_groups;
  create policy "Community members can view groups"
    on public.community_groups for select to authenticated
    using (public.is_community_member(community_id));

  drop policy if exists "Community members can read group messages" on public.group_messages;
  create policy "Community members can read group messages"
    on public.group_messages for select to authenticated
    using (exists (
      select 1 from public.community_groups as group_chat
      where group_chat.id = public.group_messages.group_id
        and public.is_community_member(group_chat.community_id)
    ));

  drop policy if exists "Community members can send group messages" on public.group_messages;
  create policy "Community members can send group messages"
    on public.group_messages for insert to authenticated
    with check (
      sender_id = (select auth.uid())
      and exists (
        select 1 from public.community_groups as group_chat
        where group_chat.id = public.group_messages.group_id
            and public.is_community_member(group_chat.community_id)
      )
  );

  drop policy if exists "Call participants can view their calls" on public.call_sessions;
  create policy "Call participants can view their calls"
      on public.call_sessions for select to authenticated
      using (caller_id = (select auth.uid()) or callee_id = (select auth.uid()));

  drop policy if exists "Users can create calls to other accounts" on public.call_sessions;
  create policy "Users can create calls to other accounts"
      on public.call_sessions for insert to authenticated
      with check (caller_id = (select auth.uid()) and callee_id <> (select auth.uid()));

  drop policy if exists "Call participants can view signaling" on public.call_signals;
  create policy "Call participants can view signaling"
      on public.call_signals for select to authenticated
      using (
          exists (
            select 1 from public.call_sessions as session
            where session.id = call_signals.call_id
              and (session.caller_id = (select auth.uid()) or session.callee_id = (select auth.uid()))
          )
      );

  drop policy if exists "Call participants can send signaling" on public.call_signals;
  create policy "Call participants can send signaling"
      on public.call_signals for insert to authenticated
      with check (
          sender_id = (select auth.uid())
          and exists (
            select 1 from public.call_sessions as session
            where session.id = call_signals.call_id
              and (session.caller_id = (select auth.uid()) or session.callee_id = (select auth.uid()))
          )
      );

  drop policy if exists "Users can manage their push subscriptions" on public.push_subscriptions;
  create policy "Users can manage their push subscriptions"
      on public.push_subscriptions for all to authenticated
      using (user_id = (select auth.uid()))
      with check (user_id = (select auth.uid()));

  revoke all on public.profiles, public.messages, public.chat_archives,
    public.hidden_chats, public.chat_clears, public.user_presence,
    public.communities, public.community_members, public.community_groups, public.group_messages
    from anon, authenticated;
  grant select on public.profiles to authenticated;
  grant select, insert on public.messages to authenticated;
  grant update (read_at) on public.messages to authenticated;
  grant select, insert, delete on public.chat_archives to authenticated;
  grant select, insert, delete on public.hidden_chats to authenticated;
  grant select, insert, delete on public.chat_clears to authenticated;
  grant select, update, insert on public.user_presence to authenticated;
  grant select on public.communities, public.community_members, public.community_groups to authenticated;
  grant select, insert on public.group_messages to authenticated;
  grant select, insert on public.call_sessions, public.call_signals to authenticated;
  grant select, insert, update, delete on public.push_subscriptions to authenticated;
  grant select on public.premium_requests, public.premium_payment_settings to authenticated;
  revoke all on public.profile_lookup_attempts from anon, authenticated;

  drop policy if exists "Mingle chat members can view message media" on storage.objects;
  create policy "Mingle chat members can view message media"
    on storage.objects for select to authenticated
    using (
      bucket_id = 'mingle-chat-media'
      and (
        (storage.foldername(name))[1] = (select auth.uid())::text
        or exists (
          select 1
          from public.messages as message
          where message.attachment_path = storage.objects.name
            and message.deleted_at is null
            and (message.sender_id = (select auth.uid()) or message.recipient_id = (select auth.uid()))
        )
        or exists (
          select 1
          from public.group_messages as message
          join public.community_groups as group_chat on group_chat.id = message.group_id
          where message.attachment_path = storage.objects.name
            and message.deleted_at is null
            and public.is_community_member(group_chat.community_id)
        )
      )
    );

  drop policy if exists "Users can upload their own chat media" on storage.objects;
  create policy "Users can upload their own chat media"
    on storage.objects for insert to authenticated
    with check (
      bucket_id = 'mingle-chat-media'
      and pg_catalog.array_length(storage.foldername(storage.objects.name), 1) in (2, 3)
      and (storage.foldername(storage.objects.name))[1] = (select auth.uid())::text
      and public.can_upload_chat_media((storage.foldername(storage.objects.name))[2])
    );

  drop policy if exists "Users can remove their own uploaded chat media" on storage.objects;
  create policy "Users can remove their own uploaded chat media"
    on storage.objects for delete to authenticated
    using (
      bucket_id = 'mingle-chat-media'
      and (storage.foldername(storage.objects.name))[1] = (select auth.uid())::text
    );

  create or replace function public.is_mingle_owner()
  returns boolean
  language sql
  stable
  security definer
  set search_path = ''
  as $$
    select auth.uid() is not null and exists (
      select 1
      from auth.users as account
      where account.id = auth.uid()
        and account.raw_app_meta_data ->> 'role' = 'owner'
    );
  $$;

  create or replace function public.is_mingle_premium()
  returns boolean
  language sql
  stable
  security definer
  set search_path = ''
  as $$
    select auth.uid() is not null and (
      public.is_mingle_owner()
      or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_premium and (p.premium_until is null or p.premium_until > now()))
    );
  $$;

  create or replace function public.request_premium_plan(p_plan_months integer, p_payment_reference text)
  returns uuid
  language plpgsql
  security definer
  set search_path = ''
  as $$
  declare
    v_amount integer;
    v_request_id uuid;
  begin
    if auth.uid() is null then raise exception 'Please log in to continue.'; end if;
    if pg_catalog.nullif(pg_catalog.btrim(coalesce(p_payment_reference, '')), '') is null then raise exception 'Enter the UPI transaction ID.'; end if;
    v_amount := case p_plan_months when 3 then 3 when 5 then 5 when 12 then 12 when 24 then 24 when 36 then 20 else null end;
    if v_amount is null then raise exception 'Choose a valid premium plan.'; end if;
    insert into public.premium_requests (user_id, plan_months, amount_rs, payment_reference)
    values (auth.uid(), p_plan_months, v_amount, pg_catalog.btrim(p_payment_reference)) returning id into v_request_id;
    return v_request_id;
  end;
  $$;

  create or replace function public.get_premium_payment_details()
  returns jsonb
  language sql
  security definer
  set search_path = ''
  as $$
    select pg_catalog.jsonb_build_object('upi_id', s.upi_id, 'qr_image_url', s.qr_image_url) from public.premium_payment_settings s where s.id = true;
  $$;

  create or replace function public.admin_set_premium_payment_details(p_upi_id text, p_qr_image_url text)
  returns void
  language plpgsql
  security definer
  set search_path = ''
  as $$
  begin
    if not public.is_mingle_owner() then raise exception 'Only the Mingle owner can manage payment details.'; end if;
    if pg_catalog.length(pg_catalog.btrim(coalesce(p_upi_id, ''))) > 120 then raise exception 'UPI ID is too long.'; end if;
    if pg_catalog.length(pg_catalog.btrim(coalesce(p_qr_image_url, ''))) > 1000 then raise exception 'QR image URL is too long.'; end if;
    update public.premium_payment_settings set upi_id = pg_catalog.btrim(coalesce(p_upi_id, '')), qr_image_url = pg_catalog.btrim(coalesce(p_qr_image_url, '')), updated_at = now() where id = true;
  end;
  $$;

  create or replace function public.admin_list_premium_requests()
  returns table(id uuid, user_id uuid, name text, email text, phone text, plan_months integer, amount_rs integer, payment_reference text, created_at timestamptz)
  language plpgsql
  security definer
  set search_path = ''
  as $$
  begin
    if not public.is_mingle_owner() then raise exception 'Only the Mingle owner can review payment requests.'; end if;
    return query select r.id, r.user_id, p.name, p.email, p.phone, r.plan_months, r.amount_rs, r.payment_reference, r.created_at
      from public.premium_requests r join public.profiles p on p.id = r.user_id where r.status = 'pending' order by r.created_at asc;
  end;
  $$;

  create or replace function public.admin_review_premium_request(p_request_id uuid, p_approve boolean)
  returns timestamptz
  language plpgsql
  security definer
  set search_path = ''
  as $$
  declare
    v_request public.premium_requests%rowtype;
    v_until timestamptz;
  begin
    if not public.is_mingle_owner() then raise exception 'Only the Mingle owner can review payment requests.'; end if;
    select * into v_request from public.premium_requests where id = p_request_id and status = 'pending' for update;
    if not found then raise exception 'This payment request is no longer pending.'; end if;
    if p_approve then
      update public.profiles set is_premium = true,
        premium_until = greatest(coalesce(premium_until, now()), now()) + make_interval(months => v_request.plan_months)
        where id = v_request.user_id returning premium_until into v_until;
      if v_until is null then raise exception 'That account does not exist.'; end if;
      update public.premium_requests set status = 'approved', reviewed_at = now() where id = p_request_id;
      return v_until;
    end if;
    update public.premium_requests set status = 'rejected', reviewed_at = now() where id = p_request_id;
    return null;
  end;
  $$;

  create or replace function public.can_delete_staged_account_media(p_storage_path text)
  returns boolean
  language sql
  stable
  security definer
  set search_path = ''
  as $$
    select public.is_mingle_owner() and exists (
      select 1
      from public.admin_media_cleanup as cleanup
      where cleanup.owner_id = auth.uid()
        and cleanup.storage_path = p_storage_path
    );
  $$;

  drop policy if exists "Owners can remove staged account media" on storage.objects;
  create policy "Owners can remove staged account media"
    on storage.objects for delete to authenticated
    using (
      bucket_id = 'mingle-chat-media'
      and public.can_delete_staged_account_media(storage.objects.name)
    );

  create or replace function public.handle_new_user()
  returns trigger
  language plpgsql
  security definer
  set search_path = ''
  as $$
  declare
    v_email text := pg_catalog.lower(pg_catalog.btrim(coalesce(new.email, '')));
    v_name text := pg_catalog.btrim(coalesce(new.raw_user_meta_data ->> 'name', ''));
    v_phone text := pg_catalog.btrim(coalesce(new.raw_user_meta_data ->> 'phone', ''));
  begin
    if v_email ~ '^m[0-9]{10}@accounts\.mingle\.invalid$' then
      return new;
    end if;

    if v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
      or v_phone !~ '^[0-9]{10}$'
      or pg_catalog.char_length(v_name) not between 1 and 40 then
      raise exception 'Enter a name, valid email, and exactly 10 mobile-number digits.';
    end if;

    insert into public.profiles (id, name, phone, email)
    values (new.id, v_name, v_phone, v_email);

    insert into public.user_presence (user_id, last_seen_at)
    values (new.id, pg_catalog.now())
    on conflict (user_id) do update
      set last_seen_at = excluded.last_seen_at;

    if new.id <> coalesce((
      select account.id
      from auth.users as account
      where account.raw_app_meta_data ->> 'role' = 'owner'
      order by account.created_at
      limit 1
    ), '00000000-0000-0000-0000-000000000000'::uuid) then
      insert into public.messages (sender_id, recipient_id, text)
      select owner_account.id, new.id,
             'Hi ' || v_name || ' welcome to Mingle 🎉' || E'\n\n' ||
             'If you encounter any issues, bugs, or other problems, you can report them in our group''s complaints section. We will work on resolving the reported complaints, bugs, errors, and other issues within 4–6 days.'
      from auth.users as owner_account
      where owner_account.raw_app_meta_data ->> 'role' = 'owner'
      order by owner_account.created_at
      limit 1;
    end if;

    return new;
  end;
  $$;

  drop trigger if exists on_mingle_user_created on auth.users;
  create trigger on_mingle_user_created
    after insert on auth.users
    for each row execute function public.handle_new_user();

  with existing_accounts as (
    select
      u.id,
      case
        when pg_catalog.lower(coalesce(u.email, '')) ~ '^m[0-9]{10}@accounts\.mingle\.invalid$' then null
        else nullif(pg_catalog.lower(pg_catalog.btrim(coalesce(u.email, ''))), '')
      end as email
    from auth.users as u
  )
  update public.profiles as profile
  set email = existing_accounts.email
  from existing_accounts
  where profile.id = existing_accounts.id
    and nullif(pg_catalog.btrim(profile.email), '') is null
    and existing_accounts.email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    and not exists (
      select 1
      from public.profiles as other_profile
      where other_profile.id <> profile.id
        and other_profile.email is not null
        and pg_catalog.lower(pg_catalog.btrim(other_profile.email)) = existing_accounts.email
    );

  with existing_accounts as (
    select
      u.id,
      pg_catalog.btrim(coalesce(u.raw_user_meta_data ->> 'name', '')) as name,
      case
        when pg_catalog.lower(coalesce(u.email, '')) ~ '^m[0-9]{10}@accounts\.mingle\.invalid$'
          then pg_catalog.substring(pg_catalog.lower(u.email), '^m([0-9]{10})@accounts\.mingle\.invalid$')
        else pg_catalog.btrim(coalesce(u.raw_user_meta_data ->> 'phone', ''))
      end as phone,
      case
        when pg_catalog.lower(coalesce(u.email, '')) ~ '^m[0-9]{10}@accounts\.mingle\.invalid$' then null
        else nullif(pg_catalog.lower(pg_catalog.btrim(coalesce(u.email, ''))), '')
      end as email
    from auth.users as u
  )
  insert into public.profiles (id, name, phone, email)
  select id, name, phone, email
  from existing_accounts
  where pg_catalog.char_length(name) between 1 and 40
    and phone ~ '^[0-9]{10}$'
  on conflict do nothing;

  create or replace function public.ensure_my_profile()
  returns setof public.profiles
  language plpgsql
  security definer
  set search_path = ''
  as $$
  declare
    v_user_id uuid := auth.uid();
    v_auth_email text := pg_catalog.lower(pg_catalog.btrim(coalesce(auth.jwt() ->> 'email', '')));
    v_name text := pg_catalog.btrim(coalesce(auth.jwt() -> 'user_metadata' ->> 'name', ''));
    v_phone text := pg_catalog.btrim(coalesce(auth.jwt() -> 'user_metadata' ->> 'phone', ''));
    v_email text;
    v_profile public.profiles;
  begin
    if v_user_id is null then
      raise exception 'Please log in to continue.';
    end if;

    if v_auth_email ~ '^m[0-9]{10}@accounts\.mingle\.invalid$' then
      v_phone := pg_catalog.substring(v_auth_email, '^m([0-9]{10})@accounts\.mingle\.invalid$');
      v_email := null;
    else
      v_email := v_auth_email;
    end if;

    if v_email is not null and v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
      raise exception 'Enter a valid email address.';
    end if;

    select p.* into v_profile
    from public.profiles as p
    where p.id = v_user_id;

    if found then
      if v_email is not null and v_profile.email is distinct from v_email then
        update public.profiles set email = v_email where id = v_user_id returning * into v_profile;
      end if;
      return next v_profile;
      return;
    end if;

    if pg_catalog.char_length(v_name) < 1 or pg_catalog.char_length(v_name) > 40 then
      raise exception 'Enter a name between 1 and 40 characters.';
    end if;

    if v_phone !~ '^[0-9]{10}$' then
      raise exception 'Enter exactly 10 digits for your mobile number.';
    end if;

    insert into public.profiles (id, name, phone, email)
    values (v_user_id, v_name, v_phone, v_email)
    returning * into v_profile;

    return next v_profile;
  end;
  $$;

  drop function if exists public.lookup_profile(text);

  create function public.lookup_profile(p_identifier text)
  returns setof public.profiles
  language plpgsql
  security definer
  set search_path = ''
  as $$
  declare
    v_user_id uuid := auth.uid();
    v_attempt_count bigint;
  begin
    if v_user_id is null then
      raise exception 'Please log in to continue.';
    end if;

    p_identifier := pg_catalog.lower(pg_catalog.btrim(coalesce(p_identifier, '')));
    if p_identifier !~ '^[0-9]{10}$'
      and p_identifier !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
      raise exception 'Enter a valid 10-digit mobile number or email address.';
    end if;

    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(v_user_id::text, 0)
    );

    delete from public.profile_lookup_attempts
    where user_id = v_user_id
      and attempted_at < pg_catalog.now() - interval '5 minutes';

    select pg_catalog.count(*) into v_attempt_count
    from public.profile_lookup_attempts
    where user_id = v_user_id;

    if v_attempt_count >= 60 then
      raise exception 'Too many account searches. Please wait a few minutes and try again.';
    end if;

    insert into public.profile_lookup_attempts (user_id) values (v_user_id);

    return query
    select p.*
    from public.profiles as p
    where (p.phone = p_identifier or pg_catalog.lower(p.email) = p_identifier)
      and p.id <> v_user_id;
  end;
  $$;

  drop function if exists public.get_chat_summaries();

  create or replace function public.get_chat_summaries(p_archived boolean default false)
  returns table (
    id uuid,
    name text,
    phone text,
    email text,
    account_number text,
    created_at timestamptz,
    last_message text,
    last_sender_id uuid,
    updated_at timestamptz,
    unread bigint
  )
  language sql
  security definer
  set search_path = ''
  as $$
    with peers as (
      select case
        when m.sender_id = auth.uid() then m.recipient_id
        else m.sender_id
      end as peer_id
      from public.messages as m
      where m.sender_id = auth.uid() or m.recipient_id = auth.uid()
      group by 1
      union
      select archive.peer_id
      from public.chat_archives as archive
      where archive.user_id = auth.uid()
    )
    select
      p.id,
      p.name,
      p.phone,
      p.email,
      p.account_number,
      p.created_at,
      latest.text,
      latest.sender_id,
      latest.created_at,
      unread.unread_count
    from peers
    join public.profiles as p on p.id = peers.peer_id
    left join public.chat_archives as archive
      on archive.user_id = auth.uid()
    and archive.peer_id = peers.peer_id
    left join public.hidden_chats as hidden_chat
      on hidden_chat.user_id = auth.uid()
     and hidden_chat.peer_id = peers.peer_id
    left join public.chat_clears as chat_clear
      on chat_clear.user_id = auth.uid()
     and chat_clear.peer_id = peers.peer_id
    left join lateral (
      select case
          when m.deleted_at is not null then 'This message was deleted.'
          when m.attachment_path is not null and m.attachment_mime like 'image/%' then 'Photo'
          when m.attachment_path is not null and m.attachment_mime like 'video/%' then 'Video'
          when m.attachment_path is not null and m.attachment_mime like 'audio/%' then 'Voice message'
          else m.text
        end as text,
        m.sender_id,
        m.created_at
      from public.messages as m
      where ((m.sender_id = auth.uid() and m.recipient_id = peers.peer_id)
        or (m.sender_id = peers.peer_id and m.recipient_id = auth.uid()))
        and m.created_at > coalesce(chat_clear.cleared_at, '-infinity'::timestamptz)
      order by m.created_at desc, m.id desc
      limit 1
    ) as latest on true
    left join lateral (
      select pg_catalog.count(*) as unread_count
      from public.messages as m
      where m.sender_id = peers.peer_id
        and m.recipient_id = auth.uid()
        and m.read_at is null
        and m.created_at > coalesce(chat_clear.cleared_at, '-infinity'::timestamptz)
    ) as unread on true
    where hidden_chat.peer_id is null
      and (archive.peer_id is not null) = p_archived
    order by latest.created_at desc nulls last;
  $$;

  create or replace function public.create_community(p_name text)
  returns uuid
  language plpgsql
  security definer
  set search_path = ''
  as $$
  declare
    v_user_id uuid := auth.uid();
    v_community_id uuid;
    v_name text := pg_catalog.btrim(coalesce(p_name, ''));
  begin
    if v_user_id is null then
      raise exception 'Please log in to continue.';
    end if;
    if pg_catalog.char_length(v_name) not between 1 and 60 then
      raise exception 'Community names must be between 1 and 60 characters.';
    end if;

    insert into public.communities (name, created_by)
    values (v_name, v_user_id)
    returning id into v_community_id;

    insert into public.community_members (community_id, user_id, role, added_by)
    values (v_community_id, v_user_id, 'owner', v_user_id);

    return v_community_id;
  end;
  $$;

  create or replace function public.create_community_group(p_community_id uuid, p_name text)
  returns uuid
  language plpgsql
  security definer
  set search_path = ''
  as $$
  declare
    v_user_id uuid := auth.uid();
    v_group_id uuid;
    v_name text := pg_catalog.btrim(coalesce(p_name, ''));
  begin
    if v_user_id is null then
      raise exception 'Please log in to continue.';
    end if;
    if pg_catalog.char_length(v_name) not between 1 and 60 then
      raise exception 'Group names must be between 1 and 60 characters.';
    end if;
    if not exists (
      select 1 from public.community_members as member
      where member.community_id = p_community_id
        and member.user_id = v_user_id
        and member.role in ('owner', 'admin')
    ) then
      raise exception 'Only community admins can create groups.';
    end if;

    insert into public.community_groups (community_id, name, created_by)
    values (p_community_id, v_name, v_user_id)
    returning id into v_group_id;

    return v_group_id;
  end;
  $$;

  create or replace function public.add_community_member(p_community_id uuid, p_identifier text)
  returns uuid
  language plpgsql
  security definer
  set search_path = ''
  as $$
  declare
    v_user_id uuid := auth.uid();
    v_identifier text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_identifier, '')));
    v_member_id uuid;
  begin
    if v_user_id is null then
      raise exception 'Please log in to continue.';
    end if;
    if not exists (
      select 1 from public.community_members as member
      where member.community_id = p_community_id
        and member.user_id = v_user_id
        and member.role in ('owner', 'admin')
    ) then
      raise exception 'Only community admins can invite members.';
    end if;
    if v_identifier !~ '^[0-9]{10}$'
      and v_identifier !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
      raise exception 'Enter a valid 10-digit mobile number or email address.';
    end if;

    select person.id into v_member_id
    from public.profiles as person
    where (person.phone = v_identifier or pg_catalog.lower(person.email) = v_identifier)
      and person.id <> v_user_id
    limit 1;
    if v_member_id is null then
      raise exception 'No Mingle account matches that mobile number or email.';
    end if;

    insert into public.community_members (community_id, user_id, role, added_by)
    values (p_community_id, v_member_id, 'member', v_user_id)
    on conflict (community_id, user_id) do nothing;

    return v_member_id;
  end;
  $$;

  create or replace function public.get_group_messages(p_group_id uuid)
  returns table (
    id uuid,
    group_id uuid,
    sender_id uuid,
    sender_name text,
    text text,
    created_at timestamptz,
    updated_at timestamptz,
    deleted_at timestamptz,
    attachment_path text,
    attachment_name text,
    attachment_mime text,
    attachment_size bigint
  )
  language plpgsql
  security definer
  set search_path = ''
  as $$
  begin
    if auth.uid() is null or not (
      exists (
        select 1
        from public.community_groups as group_chat
        join public.community_members as member on member.community_id = group_chat.community_id
        where group_chat.id = p_group_id and member.user_id = auth.uid()
      )
      or public.is_community_group_admin(p_group_id)
    ) then
      raise exception 'You are not a member of this community.';
    end if;

    return query
    select message.id, message.group_id, message.sender_id, person.name,
      message.text, message.created_at, message.updated_at, message.deleted_at,
      message.attachment_path, message.attachment_name, message.attachment_mime, message.attachment_size
    from public.group_messages as message
    join public.profiles as person on person.id = message.sender_id
    where message.group_id = p_group_id
    order by message.created_at asc, message.id asc
    limit 500;
  end;
  $$;

  create or replace function public.edit_group_message(p_message_id uuid, p_text text)
  returns void
  language plpgsql
  security definer
  set search_path = ''
  as $$
  begin
    if auth.uid() is null then
      raise exception 'Please log in to continue.';
    end if;
    if p_text is null or pg_catalog.char_length(pg_catalog.btrim(p_text)) not between 1 and 2000 then
      raise exception 'A message must contain between 1 and 2000 characters.';
    end if;

    update public.group_messages as message
    set text = pg_catalog.btrim(p_text), updated_at = pg_catalog.now()
    where message.id = p_message_id
      and message.sender_id = auth.uid()
      and message.deleted_at is null
      and message.created_at >= pg_catalog.now() - interval '45 minutes';

    if not found then
      raise exception 'This message cannot be edited. Messages can only be edited within 45 minutes.';
    end if;
  end;
  $$;

  create or replace function public.delete_group_message(p_message_id uuid)
  returns void
  language plpgsql
  security definer
  set search_path = ''
  as $$
  begin
    if auth.uid() is null then
      raise exception 'Please log in to continue.';
    end if;

    update public.group_messages as message
    set text = null,
        attachment_path = null,
        attachment_name = null,
        attachment_mime = null,
        attachment_size = null,
        deleted_at = pg_catalog.now(),
        updated_at = pg_catalog.now()
    where message.id = p_message_id
      and message.sender_id = auth.uid()
      and message.deleted_at is null;

    if not found then
      raise exception 'This message cannot be deleted.';
    end if;
  end;
  $$;

  create or replace function public.edit_message(p_message_id uuid, p_text text)
  returns void
  language plpgsql
  security definer
  set search_path = ''
  as $$
  begin
    if auth.uid() is null then
      raise exception 'Please log in to continue.';
    end if;

    if p_text is null or pg_catalog.char_length(pg_catalog.btrim(p_text)) not between 1 and 2000 then
      raise exception 'A message must contain between 1 and 2000 characters.';
    end if;

    update public.messages
    set text = pg_catalog.btrim(p_text), updated_at = pg_catalog.now()
    where id = p_message_id
      and sender_id = auth.uid()
      and deleted_at is null
      and created_at >= pg_catalog.now() - interval '45 minutes';

    if not found then
      raise exception 'This message cannot be edited. Messages can only be edited within 45 minutes.';
    end if;
  end;
  $$;

  create or replace function public.delete_message(p_message_id uuid)
  returns void
  language plpgsql
  security definer
  set search_path = ''
  as $$
  begin
    if auth.uid() is null then
      raise exception 'Please log in to continue.';
    end if;

    update public.messages
    set text = null,
        attachment_path = null,
        attachment_name = null,
        attachment_mime = null,
        attachment_size = null,
        deleted_at = pg_catalog.now(),
        updated_at = pg_catalog.now()
    where id = p_message_id
      and sender_id = auth.uid()
      and deleted_at is null;

    if not found then
      raise exception 'This message cannot be deleted.';
    end if;
  end;
  $$;

  create or replace function public.account_media_paths(p_user_id uuid)
  returns table(storage_path text)
  language sql
  stable
  security definer
  set search_path = ''
  as $$
    select distinct object.name
    from storage.objects as object
    where object.bucket_id = 'mingle-chat-media'
      and (
        (storage.foldername(object.name))[1] = p_user_id::text
        or exists (
          select 1
          from public.messages as message
          where message.attachment_path = object.name
            and (message.sender_id = p_user_id or message.recipient_id = p_user_id)
        )
        or exists (
          select 1
          from public.group_messages as message
          join public.community_groups as group_chat on group_chat.id = message.group_id
          join public.communities as community on community.id = group_chat.community_id
          where message.attachment_path = object.name
            and (message.sender_id = p_user_id or community.created_by = p_user_id)
        )
        or exists (
          select 1
          from public.group_messages as message
          join public.community_groups as group_chat on group_chat.id = message.group_id
          where message.attachment_path = object.name
            and group_chat.created_by = p_user_id
        )
      );
  $$;

  create or replace function public.admin_list_accounts()
  returns table(id uuid, name text, phone text, email text, created_at timestamptz, is_owner boolean)
  language plpgsql
  security definer
  set search_path = ''
  as $$
  begin
    if not public.is_mingle_owner() then
      raise exception 'Only the Mingle owner can manage accounts.';
    end if;

    return query
      select profile.id,
             profile.name,
             profile.phone,
             coalesce(profile.email, account.email)::text,
             profile.created_at,
             coalesce(account.raw_app_meta_data ->> 'role', '') = 'owner'
      from public.profiles as profile
      join auth.users as account on account.id = profile.id
      order by profile.created_at desc;
  end;
  $$;

  create or replace function public.admin_prepare_account_deletion(p_user_id uuid)
  returns table(storage_path text)
  language plpgsql
  security definer
  set search_path = ''
  as $$
  begin
    if not public.is_mingle_owner() then
      raise exception 'Only the Mingle owner can manage accounts.';
    end if;
    if p_user_id is null or p_user_id = auth.uid() then
      raise exception 'You cannot delete your own account.';
    end if;
    if not exists (select 1 from auth.users as account where account.id = p_user_id) then
      raise exception 'That account no longer exists.';
    end if;
    if exists (
      select 1 from auth.users as account
      where account.id = p_user_id
        and account.raw_app_meta_data ->> 'role' = 'owner'
    ) then
      raise exception 'Another owner account cannot be deleted.';
    end if;

    delete from public.admin_media_cleanup as cleanup
    where cleanup.owner_id = auth.uid()
      and cleanup.target_user_id = p_user_id;

    insert into public.admin_media_cleanup (owner_id, target_user_id, storage_path)
    select auth.uid(), p_user_id, media.storage_path
    from public.account_media_paths(p_user_id) as media
    on conflict do nothing;

    return query
      select cleanup.storage_path
      from public.admin_media_cleanup as cleanup
      join storage.objects as object
        on object.name = cleanup.storage_path
       and object.bucket_id = 'mingle-chat-media'
      where cleanup.owner_id = auth.uid()
        and cleanup.target_user_id = p_user_id
      order by cleanup.storage_path;
  end;
  $$;

  create or replace function public.admin_delete_account(p_user_id uuid)
  returns void
  language plpgsql
  security definer
  set search_path = ''
  as $$
  begin
    if not public.is_mingle_owner() then
      raise exception 'Only the Mingle owner can manage accounts.';
    end if;
    if p_user_id is null or p_user_id = auth.uid() then
      raise exception 'You cannot delete your own account.';
    end if;
    if not exists (select 1 from auth.users as account where account.id = p_user_id) then
      raise exception 'That account no longer exists.';
    end if;
    if exists (
      select 1 from auth.users as account
      where account.id = p_user_id
        and account.raw_app_meta_data ->> 'role' = 'owner'
    ) then
      raise exception 'Another owner account cannot be deleted.';
    end if;

    delete from public.messages as message
    where message.sender_id = p_user_id
       or message.recipient_id = p_user_id;

    delete from public.group_messages as message
    where message.sender_id = p_user_id;

    delete from auth.users as account
    where account.id = p_user_id
      and coalesce(account.raw_app_meta_data ->> 'role', '') <> 'owner';
    if not found then
      raise exception 'The account could not be deleted.';
    end if;

    delete from public.admin_media_cleanup as cleanup
    where cleanup.owner_id = auth.uid()
      and cleanup.target_user_id = p_user_id;
  end;
  $$;

  revoke all on function public.is_mingle_owner() from public, anon;
  revoke all on function public.is_mingle_premium() from public, anon;
  revoke all on function public.request_premium_plan(integer, text) from public, anon;
  revoke all on function public.get_premium_payment_details() from public, anon;
  revoke all on function public.admin_set_premium_payment_details(text, text) from public, anon;
  revoke all on function public.admin_list_premium_requests() from public, anon;
  revoke all on function public.admin_review_premium_request(uuid, boolean) from public, anon;
  revoke all on function public.can_delete_staged_account_media(text) from public, anon;
  revoke all on function public.account_media_paths(uuid) from public, anon, authenticated;
  revoke all on function public.admin_list_accounts() from public, anon;
  revoke all on function public.admin_prepare_account_deletion(uuid) from public, anon;
  revoke all on function public.admin_delete_account(uuid) from public, anon;
  grant execute on function public.is_mingle_owner() to authenticated;
  grant execute on function public.is_mingle_premium() to authenticated;
  grant execute on function public.request_premium_plan(integer, text) to authenticated;
  grant execute on function public.get_premium_payment_details() to authenticated;
  grant execute on function public.admin_set_premium_payment_details(text, text) to authenticated;
  grant execute on function public.admin_list_premium_requests() to authenticated;
  grant execute on function public.admin_review_premium_request(uuid, boolean) to authenticated;
  grant execute on function public.can_delete_staged_account_media(text) to authenticated;
  grant execute on function public.admin_list_accounts() to authenticated;
  grant execute on function public.admin_prepare_account_deletion(uuid) to authenticated;
  grant execute on function public.admin_delete_account(uuid) to authenticated;

  revoke all on function public.ensure_my_profile() from public, anon;
  revoke all on function public.handle_new_user() from public, anon, authenticated;
  revoke all on function public.lookup_profile(text) from public, anon;
  revoke all on function public.get_chat_summaries(boolean) from public, anon;
  revoke all on function public.is_community_member(uuid) from public, anon;
  revoke all on function public.can_upload_chat_media(text) from public, anon;
  revoke all on function public.create_community(text) from public, anon;
  revoke all on function public.create_community_group(uuid, text) from public, anon;
  revoke all on function public.add_community_member(uuid, text) from public, anon;
  revoke all on function public.get_group_messages(uuid) from public, anon;
  revoke all on function public.edit_group_message(uuid, text) from public, anon;
  revoke all on function public.delete_group_message(uuid) from public, anon;
  revoke all on function public.edit_message(uuid, text) from public, anon;
  revoke all on function public.delete_message(uuid) from public, anon;
  grant execute on function public.ensure_my_profile() to authenticated;
  grant execute on function public.lookup_profile(text) to authenticated;
  grant execute on function public.get_chat_summaries(boolean) to authenticated;
  grant execute on function public.is_community_member(uuid) to authenticated;
  grant execute on function public.can_upload_chat_media(text) to authenticated;
  grant execute on function public.create_community(text) to authenticated;
  grant execute on function public.create_community_group(uuid, text) to authenticated;
  grant execute on function public.add_community_member(uuid, text) to authenticated;
  grant execute on function public.get_group_messages(uuid) to authenticated;
  grant execute on function public.edit_group_message(uuid, text) to authenticated;
  grant execute on function public.delete_group_message(uuid) to authenticated;
  grant execute on function public.edit_message(uuid, text) to authenticated;
  grant execute on function public.delete_message(uuid) to authenticated;

  do $$
  begin
    if not exists (
      select 1
      from pg_catalog.pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'messages'
    ) then
      alter publication supabase_realtime add table public.messages;
    end if;
    if not exists (
      select 1
      from pg_catalog.pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'group_messages'
    ) then
      alter publication supabase_realtime add table public.group_messages;
    end if;
    if not exists (
      select 1
      from pg_catalog.pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'call_sessions'
    ) then
      alter publication supabase_realtime add table public.call_sessions;
    end if;
    if not exists (
      select 1
      from pg_catalog.pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'call_signals'
    ) then
      alter publication supabase_realtime add table public.call_signals;
    end if;
  end;
  $$;

  notify pgrst, 'reload schema';

  create table if not exists public.profile_avatars (
    user_id uuid primary key references public.profiles (id) on delete cascade,
    storage_path text not null unique,
    visibility text not null default 'everyone' check (visibility in ('everyone', 'contacts', 'nobody')),
    updated_at timestamptz not null default now()
  );

  create table if not exists public.saved_messages (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references public.profiles (id) on delete cascade,
    text text not null check (char_length(btrim(text)) between 1 and 2000),
    created_at timestamptz not null default now()
  );

  create index if not exists saved_messages_user_created_idx
    on public.saved_messages (user_id, created_at);

  create table if not exists public.statuses (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references public.profiles (id) on delete cascade,
    text text,
    media_path text,
    media_mime text,
    media_size bigint,
    created_at timestamptz not null default now(),
    expires_at timestamptz not null default (now() + interval '24 hours'),
    constraint statuses_content_check check (
      nullif(btrim(text), '') is not null or media_path is not null
    ),
    constraint statuses_text_check check (text is null or char_length(btrim(text)) between 1 and 700),
    constraint statuses_media_check check (
      (media_path is null and media_mime is null and media_size is null)
      or (
        media_path is not null
        and media_mime is not null
        and media_mime in ('image/jpeg', 'image/png', 'image/webp', 'image/gif')
        and media_size is not null
        and media_size between 1 and 10485760
      )
    ),
    constraint statuses_expiry_check check (expires_at > created_at and expires_at <= created_at + interval '24 hours')
  );

  create index if not exists statuses_active_created_idx
    on public.statuses (expires_at, created_at desc);

  create table if not exists public.channels (
    id uuid primary key default gen_random_uuid(),
    name text not null check (char_length(btrim(name)) between 1 and 60),
    description text not null default '' check (char_length(description) <= 500),
    owner_id uuid not null references public.profiles (id) on delete cascade,
    created_at timestamptz not null default now()
  );

  create table if not exists public.channel_admins (
    channel_id uuid not null references public.channels (id) on delete cascade,
    user_id uuid not null references public.profiles (id) on delete cascade,
    role text not null default 'admin' check (role in ('owner', 'admin')),
    created_at timestamptz not null default now(),
    primary key (channel_id, user_id)
  );

  create table if not exists public.channel_follows (
    channel_id uuid not null references public.channels (id) on delete cascade,
    user_id uuid not null references public.profiles (id) on delete cascade,
    created_at timestamptz not null default now(),
    primary key (channel_id, user_id)
  );

  create table if not exists public.channel_posts (
    id uuid primary key default gen_random_uuid(),
    channel_id uuid not null references public.channels (id) on delete cascade,
    author_id uuid not null references public.profiles (id) on delete cascade,
    text text,
    media_path text,
    media_mime text,
    media_size bigint,
    created_at timestamptz not null default now(),
    constraint channel_posts_content_check check (
      nullif(btrim(text), '') is not null or media_path is not null
    ),
    constraint channel_posts_text_check check (text is null or char_length(btrim(text)) between 1 and 2000),
    constraint channel_posts_media_check check (
      (media_path is null and media_mime is null and media_size is null)
      or (
        media_path is not null
        and media_mime is not null
        and media_mime in ('image/jpeg', 'image/png', 'image/webp', 'image/gif')
        and media_size is not null
        and media_size between 1 and 10485760
      )
    )
  );

  create index if not exists channel_posts_created_idx
    on public.channel_posts (channel_id, created_at desc);

  create or replace function public.account_media_paths(p_user_id uuid)
  returns table(storage_path text)
  language sql
  stable
  security definer
  set search_path = ''
  as $$
    select distinct object.name
    from storage.objects as object
    where object.bucket_id = 'mingle-chat-media'
      and (
        (storage.foldername(object.name))[1] = p_user_id::text
        or exists (
          select 1
          from public.messages as message
          where message.attachment_path = object.name
            and (message.sender_id = p_user_id or message.recipient_id = p_user_id)
        )
        or exists (
          select 1
          from public.group_messages as message
          join public.community_groups as group_chat on group_chat.id = message.group_id
          join public.communities as community on community.id = group_chat.community_id
          where message.attachment_path = object.name
            and (message.sender_id = p_user_id or community.created_by = p_user_id)
        )
        or exists (
          select 1
          from public.group_messages as message
          join public.community_groups as group_chat on group_chat.id = message.group_id
          where message.attachment_path = object.name
            and group_chat.created_by = p_user_id
        )
        or exists (
          select 1
          from public.channel_posts as post
          join public.channels as channel on channel.id = post.channel_id
          where post.media_path = object.name
            and (post.author_id = p_user_id or channel.owner_id = p_user_id)
        )
      );
  $$;

  create table if not exists public.community_group_admins (
    group_id uuid not null references public.community_groups (id) on delete cascade,
    user_id uuid not null references public.profiles (id) on delete cascade,
    role text not null default 'admin' check (role in ('owner', 'admin')),
    created_at timestamptz not null default now(),
    primary key (group_id, user_id)
  );

  insert into public.community_group_admins (group_id, user_id, role)
  select id, created_by, 'owner' from public.community_groups
  on conflict (group_id, user_id) do nothing;

  create or replace function public.register_community_group_owner()
  returns trigger
  language plpgsql
  security definer
  set search_path = ''
  as $$
  begin
    insert into public.community_group_admins (group_id, user_id, role)
    values (new.id, new.created_by, 'owner')
    on conflict (group_id, user_id) do nothing;
    return new;
  end;
  $$;

  drop trigger if exists community_group_owner_admin on public.community_groups;
  create trigger community_group_owner_admin
    after insert on public.community_groups
    for each row execute function public.register_community_group_owner();

  alter table public.community_group_admins enable row level security;

  drop policy if exists "Community members can view group admins" on public.community_group_admins;
  create policy "Community members can view group admins"
    on public.community_group_admins for select to authenticated
    using (exists (
      select 1 from public.community_groups as group_chat
      where group_chat.id = community_group_admins.group_id
        and public.is_community_member(group_chat.community_id)
    ));

  revoke all on public.community_group_admins from anon, authenticated;
  grant select on public.community_group_admins to authenticated;

  create or replace function public.is_community_group_admin(p_group_id uuid)
  returns boolean
  language sql
  stable
  security definer
  set search_path = ''
  as $$
    select auth.uid() is not null and exists (
      select 1 from public.community_groups as group_chat
      where group_chat.id = p_group_id
        and (
          group_chat.created_by = auth.uid()
          or exists (
            select 1 from public.community_group_admins as admin
            where admin.group_id = group_chat.id and admin.user_id = auth.uid()
          )
          or exists (
            select 1 from public.community_members as member
            where member.community_id = group_chat.community_id
              and member.user_id = auth.uid()
              and member.role in ('owner', 'admin')
          )
        )
    );
  $$;

  create or replace function public.get_community_group_admins(p_group_id uuid)
  returns table (user_id uuid, user_name text, role text)
  language plpgsql
  stable
  security definer
  set search_path = ''
  as $$
  begin
    if auth.uid() is null or not public.is_community_group_admin(p_group_id) then
      raise exception 'Only this group creator or an admin can manage group admins.';
    end if;
    return query
      select admin.user_id, person.name, admin.role
      from public.community_group_admins as admin
      join public.profiles as person on person.id = admin.user_id
      where admin.group_id = p_group_id
      order by case when admin.role = 'owner' then 0 else 1 end, person.name;
  end;
  $$;

  create or replace function public.add_community_group_admin(p_group_id uuid, p_identifier text)
  returns void
  language plpgsql
  security definer
  set search_path = ''
  as $$
  declare
    v_person_id uuid;
    v_community_id uuid;
    v_identifier text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_identifier, '')));
  begin
    if auth.uid() is null or not public.is_community_group_admin(p_group_id) then
      raise exception 'Only this group creator or an admin can add group admins.';
    end if;
    select group_chat.community_id into v_community_id
    from public.community_groups as group_chat
    where group_chat.id = p_group_id;
    if v_community_id is null then raise exception 'That group could not be found.'; end if;
    select person.id into v_person_id
    from public.profiles as person
    where person.phone = v_identifier or pg_catalog.lower(person.email) = v_identifier
    limit 1;
    if v_person_id is null then raise exception 'No Mingle account matches that phone number or email.'; end if;
    if not exists (
      select 1 from public.community_members as member
      where member.community_id = v_community_id and member.user_id = v_person_id
    ) then raise exception 'Only an existing community member can be a group admin.'; end if;
    insert into public.community_group_admins (group_id, user_id, role)
    values (p_group_id, v_person_id, 'admin')
    on conflict (group_id, user_id) do nothing;
  end;
  $$;

  create or replace function public.remove_community_group_admin(p_group_id uuid, p_user_id uuid)
  returns void
  language plpgsql
  security definer
  set search_path = ''
  as $$
  begin
    if auth.uid() is null or not public.is_community_group_admin(p_group_id) then
      raise exception 'Only this group creator or an admin can remove group admins.';
    end if;
    delete from public.community_group_admins
    where group_id = p_group_id and user_id = p_user_id and role <> 'owner';
    if not found then raise exception 'That group admin could not be removed.'; end if;
  end;
  $$;

  alter table public.profile_avatars enable row level security;
  alter table public.saved_messages enable row level security;
  alter table public.statuses enable row level security;
  alter table public.channels enable row level security;
  alter table public.channel_admins enable row level security;
  alter table public.channel_follows enable row level security;
  alter table public.channel_posts enable row level security;

  drop policy if exists "Community members can view their communities" on public.communities;
  create policy "Community members can view their communities"
    on public.communities for select to authenticated
    using (
      public.is_community_member(id)
      or created_by = (select auth.uid())
      or exists (
        select 1 from public.community_groups as group_chat
        where group_chat.community_id = communities.id
          and group_chat.created_by = (select auth.uid())
      )
    );

  drop policy if exists "Community members can view groups" on public.community_groups;
  create policy "Community members can view groups"
    on public.community_groups for select to authenticated
    using (
      public.is_community_member(community_id)
      or public.is_community_group_admin(id)
    );

  drop policy if exists "Community members can read group messages" on public.group_messages;
  create policy "Community members can read group messages"
    on public.group_messages for select to authenticated
    using (exists (
      select 1 from public.community_groups as group_chat
      where group_chat.id = group_messages.group_id
        and (
          public.is_community_member(group_chat.community_id)
          or public.is_community_group_admin(group_chat.id)
        )
    ));

  drop policy if exists "Community members can send group messages" on public.group_messages;
  create policy "Community members can send group messages"
    on public.group_messages for insert to authenticated
    with check (
      sender_id = (select auth.uid())
      and exists (
        select 1 from public.community_groups as group_chat
        where group_chat.id = group_messages.group_id
          and (
            public.is_community_member(group_chat.community_id)
            or public.is_community_group_admin(group_chat.id)
          )
      )
    );

  drop policy if exists "Mingle users can view permitted avatars" on public.profile_avatars;
  create policy "Mingle users can view permitted avatars"
    on public.profile_avatars for select to authenticated
    using (
      user_id = (select auth.uid())
      or visibility = 'everyone'
      or (
        visibility = 'contacts'
        and exists (
          select 1 from public.messages as message
          where (message.sender_id = profile_avatars.user_id and message.recipient_id = (select auth.uid()))
             or (message.recipient_id = profile_avatars.user_id and message.sender_id = (select auth.uid()))
        )
      )
    );

  drop policy if exists "Users can manage their saved messages" on public.saved_messages;
  create policy "Users can manage their saved messages"
    on public.saved_messages for all to authenticated
    using (user_id = (select auth.uid()))
    with check (user_id = (select auth.uid()));

  drop policy if exists "Mingle users can view active statuses" on public.statuses;
  create policy "Mingle users can view active statuses"
    on public.statuses for select to authenticated
    using (expires_at > now());

  drop policy if exists "Users can publish their own statuses" on public.statuses;
  create policy "Users can publish their own statuses"
    on public.statuses for insert to authenticated
    with check (
      user_id = (select auth.uid())
      and expires_at > now()
      and expires_at <= created_at + interval '24 hours'
      and (media_path is null or media_path like (select auth.uid())::text || '/status/%')
    );

  drop policy if exists "Users can remove their own statuses" on public.statuses;
  create policy "Users can remove their own statuses"
    on public.statuses for delete to authenticated
    using (user_id = (select auth.uid()));

  drop policy if exists "Mingle users can discover channels" on public.channels;
  create policy "Mingle users can discover channels"
    on public.channels for select to authenticated
    using (true);

  drop policy if exists "Mingle users can view channel admins" on public.channel_admins;
  create policy "Mingle users can view channel admins"
    on public.channel_admins for select to authenticated
    using (true);

  drop policy if exists "Users can view their channel follows" on public.channel_follows;
  create policy "Users can view their channel follows"
    on public.channel_follows for select to authenticated
    using (user_id = (select auth.uid()));

  drop policy if exists "Mingle users can view channel posts" on public.channel_posts;
  create policy "Mingle users can view channel posts"
    on public.channel_posts for select to authenticated
    using (true);

  revoke all on public.profile_avatars, public.saved_messages, public.statuses, public.channels,
    public.channel_admins, public.channel_follows, public.channel_posts
    from anon, authenticated;
  grant select on public.profile_avatars to authenticated;
  grant select, insert, delete on public.saved_messages to authenticated;
  grant select, delete on public.statuses to authenticated;
  grant select on public.channels, public.channel_admins, public.channel_follows, public.channel_posts to authenticated;

  create or replace function public.is_channel_admin(p_channel_id uuid)
  returns boolean
  language sql
  stable
  security definer
  set search_path = ''
  as $$
    select auth.uid() is not null and exists (
      select 1 from public.channel_admins as admin
      where admin.channel_id = p_channel_id and admin.user_id = auth.uid()
    );
  $$;

  create or replace function public.can_upload_chat_media(p_target_id text)
  returns boolean
  language sql
  stable
  security definer
  set search_path = ''
  as $$
    select auth.uid() is not null and (
      p_target_id in ('avatar', 'status')
      or exists (
        select 1 from public.channels as channel
        where channel.id::text = p_target_id and public.is_channel_admin(channel.id)
      )
      or exists (
        select 1 from public.profiles as recipient
        where recipient.id::text = p_target_id and recipient.id <> auth.uid()
      )
      or exists (
        select 1 from public.community_groups as group_chat
        where group_chat.id::text = p_target_id and (
          public.is_community_member(group_chat.community_id)
          or public.is_community_group_admin(group_chat.id)
        )
      )
    );
  $$;

  drop policy if exists "Mingle chat members can view message media" on storage.objects;
  create policy "Mingle chat members can view message media"
    on storage.objects for select to authenticated
    using (
      bucket_id = 'mingle-chat-media'
      and (
        (storage.foldername(name))[1] = (select auth.uid())::text
        or exists (
          select 1 from public.messages as message
          where message.attachment_path = storage.objects.name
            and message.deleted_at is null
            and (message.sender_id = (select auth.uid()) or message.recipient_id = (select auth.uid()))
        )
        or exists (
          select 1 from public.group_messages as message
          join public.community_groups as group_chat on group_chat.id = message.group_id
          where message.attachment_path = storage.objects.name
            and message.deleted_at is null
            and (
              public.is_community_member(group_chat.community_id)
              or public.is_community_group_admin(group_chat.id)
            )
        )
        or exists (
          select 1 from public.profile_avatars as avatar
          where avatar.storage_path = storage.objects.name
        )
        or exists (
          select 1 from public.statuses as status
          where status.media_path = storage.objects.name and status.expires_at > now()
        )
        or exists (
          select 1 from public.channel_posts as post
          where post.media_path = storage.objects.name
        )
      )
    );

  create or replace function public.set_my_avatar(p_storage_path text, p_visibility text)
  returns void
  language plpgsql
  security definer
  set search_path = ''
  as $$
  begin
    if auth.uid() is null or p_visibility is null or p_visibility not in ('everyone', 'contacts', 'nobody') then
      raise exception 'Choose a valid profile picture visibility.';
    end if;
    if p_storage_path !~ ('^' || auth.uid()::text || '/avatar/[^/]+$')
      or not exists (
        select 1 from storage.objects as object
        where object.bucket_id = 'mingle-chat-media' and object.name = p_storage_path
          and object.metadata ->> 'mimetype' in ('image/jpeg', 'image/png', 'image/webp', 'image/gif')
          and (object.metadata ->> 'size')::bigint between 1 and 10485760
      ) then
      raise exception 'Upload a valid profile picture before saving it.';
    end if;
    insert into public.profile_avatars (user_id, storage_path, visibility, updated_at)
    values (auth.uid(), p_storage_path, p_visibility, now())
    on conflict (user_id) do update
      set storage_path = excluded.storage_path,
          visibility = excluded.visibility,
          updated_at = excluded.updated_at;
  end;
  $$;

  create or replace function public.get_active_statuses()
  returns table (
    id uuid,
    user_id uuid,
    user_name text,
    text text,
    media_path text,
    media_mime text,
    created_at timestamptz,
    expires_at timestamptz
  )
  language sql
  stable
  security definer
  set search_path = ''
  as $$
    select status.id, status.user_id, person.name, status.text, status.media_path,
      status.media_mime, status.created_at, status.expires_at
    from public.statuses as status
    join public.profiles as person on person.id = status.user_id
    where status.expires_at > now()
    order by status.created_at desc;
  $$;

  create or replace function public.create_status(
    p_text text,
    p_media_path text,
    p_media_mime text,
    p_media_size bigint
  )
  returns uuid
  language plpgsql
  security definer
  set search_path = ''
  as $$
  declare
    v_user_id uuid := auth.uid();
    v_text text := nullif(pg_catalog.btrim(coalesce(p_text, '')), '');
    v_id uuid;
  begin
    if v_user_id is null then raise exception 'Please log in to post a status.'; end if;
    if v_text is null and p_media_path is null then raise exception 'Add text or a photo to your status.'; end if;
    if v_text is not null and pg_catalog.char_length(v_text) > 700 then
      raise exception 'Status text must be 700 characters or fewer.';
    end if;
    if p_media_path is not null and (
      p_media_path !~ ('^' || v_user_id::text || '/status/[^/]+$')
      or p_media_mime is null
      or p_media_mime not in ('image/jpeg', 'image/png', 'image/webp', 'image/gif')
      or p_media_size is null
      or p_media_size not between 1 and 10485760
      or not exists (
        select 1 from storage.objects as object
        where object.bucket_id = 'mingle-chat-media' and object.name = p_media_path
          and object.metadata ->> 'mimetype' = p_media_mime
          and object.metadata ->> 'size' = p_media_size::text
      )
    ) then raise exception 'Upload a valid image under 10 MB for your status.'; end if;
    insert into public.statuses (user_id, text, media_path, media_mime, media_size)
    values (v_user_id, v_text, p_media_path, p_media_mime, p_media_size)
    returning id into v_id;
    return v_id;
  end;
  $$;

  create or replace function public.create_channel(p_name text, p_description text)
  returns uuid
  language plpgsql
  security definer
  set search_path = ''
  as $$
  declare
    v_user_id uuid := auth.uid();
    v_channel_id uuid;
    v_name text := pg_catalog.btrim(coalesce(p_name, ''));
    v_description text := pg_catalog.btrim(coalesce(p_description, ''));
  begin
    if v_user_id is null then raise exception 'Please log in to create a channel.'; end if;
    if pg_catalog.char_length(v_name) not between 1 and 60 then
      raise exception 'Channel names must be between 1 and 60 characters.';
    end if;
    if pg_catalog.char_length(v_description) > 500 then
      raise exception 'Channel descriptions must be 500 characters or fewer.';
    end if;
    insert into public.channels (name, description, owner_id)
    values (v_name, v_description, v_user_id)
    returning id into v_channel_id;
    insert into public.channel_admins (channel_id, user_id, role)
    values (v_channel_id, v_user_id, 'owner');
    return v_channel_id;
  end;
  $$;

  create or replace function public.get_channels()
  returns table (
    id uuid,
    name text,
    description text,
    owner_id uuid,
    owner_name text,
    created_at timestamptz,
    follower_count bigint,
    is_following boolean,
    can_post boolean,
    latest_text text,
    latest_at timestamptz
  )
  language sql
  stable
  security definer
  set search_path = ''
  as $$
    select channel.id, channel.name, channel.description, channel.owner_id, owner.name,
      channel.created_at, counts.follower_count,
      exists (
        select 1 from public.channel_follows as follow
        where follow.channel_id = channel.id and follow.user_id = auth.uid()
      ),
      public.is_channel_admin(channel.id),
      latest.text, latest.created_at
    from public.channels as channel
    join public.profiles as owner on owner.id = channel.owner_id
    left join lateral (
      select pg_catalog.count(*) as follower_count
      from public.channel_follows as follow
      where follow.channel_id = channel.id
    ) as counts on true
    left join lateral (
      select post.text, post.created_at
      from public.channel_posts as post
      where post.channel_id = channel.id
      order by post.created_at desc
      limit 1
    ) as latest on true
    order by latest.created_at desc nulls last, channel.created_at desc;
  $$;

  create or replace function public.follow_channel(p_channel_id uuid, p_follow boolean)
  returns void
  language plpgsql
  security definer
  set search_path = ''
  as $$
  begin
    if auth.uid() is null then raise exception 'Please log in to follow a channel.'; end if;
    if not exists (select 1 from public.channels where id = p_channel_id) then
      raise exception 'That channel could not be found.';
    end if;
    if p_follow then
      insert into public.channel_follows (channel_id, user_id)
      values (p_channel_id, auth.uid()) on conflict do nothing;
    else
      delete from public.channel_follows
      where channel_id = p_channel_id and user_id = auth.uid();
    end if;
  end;
  $$;

  create or replace function public.create_channel_post(
    p_channel_id uuid,
    p_text text,
    p_media_path text,
    p_media_mime text,
    p_media_size bigint
  )
  returns uuid
  language plpgsql
  security definer
  set search_path = ''
  as $$
  declare
    v_text text := nullif(pg_catalog.btrim(coalesce(p_text, '')), '');
    v_id uuid;
  begin
    if auth.uid() is null or not public.is_channel_admin(p_channel_id) then
      raise exception 'Only channel admins can publish posts.';
    end if;
    if v_text is null and p_media_path is null then raise exception 'Add text or a photo to your post.'; end if;
    if v_text is not null and pg_catalog.char_length(v_text) > 2000 then
      raise exception 'Channel posts must be 2,000 characters or fewer.';
    end if;
    if p_media_path is not null and (
      p_media_path !~ ('^' || auth.uid()::text || '/' || p_channel_id::text || '/[^/]+$')
      or p_media_mime is null
      or p_media_mime not in ('image/jpeg', 'image/png', 'image/webp', 'image/gif')
      or p_media_size is null
      or p_media_size not between 1 and 10485760
      or not exists (
        select 1 from storage.objects as object
        where object.bucket_id = 'mingle-chat-media' and object.name = p_media_path
          and object.metadata ->> 'mimetype' = p_media_mime
          and object.metadata ->> 'size' = p_media_size::text
      )
    ) then raise exception 'Upload a valid image under 10 MB for your post.'; end if;
    insert into public.channel_posts (channel_id, author_id, text, media_path, media_mime, media_size)
    values (p_channel_id, auth.uid(), v_text, p_media_path, p_media_mime, p_media_size)
    returning id into v_id;
    return v_id;
  end;
  $$;

  create or replace function public.get_channel_posts(p_channel_id uuid)
  returns table (
    id uuid,
    author_id uuid,
    author_name text,
    text text,
    media_path text,
    media_mime text,
    created_at timestamptz
  )
  language sql
  stable
  security definer
  set search_path = ''
  as $$
    select post.id, post.author_id, person.name, post.text, post.media_path, post.media_mime, post.created_at
    from public.channel_posts as post
    join public.profiles as person on person.id = post.author_id
    where post.channel_id = p_channel_id
    order by post.created_at desc
    limit 100;
  $$;

  revoke all on function public.is_channel_admin(uuid) from public, anon;
  revoke all on function public.register_community_group_owner() from public, anon, authenticated;
  revoke all on function public.is_community_group_admin(uuid) from public, anon;
  revoke all on function public.get_community_group_admins(uuid) from public, anon;
  revoke all on function public.add_community_group_admin(uuid, text) from public, anon;
  revoke all on function public.remove_community_group_admin(uuid, uuid) from public, anon;
  revoke all on function public.set_my_avatar(text, text) from public, anon;
  revoke all on function public.get_active_statuses() from public, anon;
  revoke all on function public.create_status(text, text, text, bigint) from public, anon;
  revoke all on function public.create_channel(text, text) from public, anon;
  revoke all on function public.get_channels() from public, anon;
  revoke all on function public.follow_channel(uuid, boolean) from public, anon;
  revoke all on function public.create_channel_post(uuid, text, text, text, bigint) from public, anon;
  revoke all on function public.get_channel_posts(uuid) from public, anon;
  grant execute on function public.is_channel_admin(uuid) to authenticated;
  grant execute on function public.is_community_group_admin(uuid) to authenticated;
  grant execute on function public.get_community_group_admins(uuid) to authenticated;
  grant execute on function public.add_community_group_admin(uuid, text) to authenticated;
  grant execute on function public.remove_community_group_admin(uuid, uuid) to authenticated;
  grant execute on function public.set_my_avatar(text, text) to authenticated;
  grant execute on function public.get_active_statuses() to authenticated;
  grant execute on function public.create_status(text, text, text, bigint) to authenticated;
  grant execute on function public.create_channel(text, text) to authenticated;
  grant execute on function public.get_channels() to authenticated;
  grant execute on function public.follow_channel(uuid, boolean) to authenticated;
  grant execute on function public.create_channel_post(uuid, text, text, text, bigint) to authenticated;
  grant execute on function public.get_channel_posts(uuid) to authenticated;

  notify pgrst, 'reload schema';
