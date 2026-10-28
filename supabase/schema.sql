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
alter table public.communities enable row level security;
alter table public.community_members enable row level security;
alter table public.community_groups enable row level security;
alter table public.group_messages enable row level security;

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

revoke all on public.profiles, public.messages, public.chat_archives,
  public.communities, public.community_members, public.community_groups, public.group_messages
  from anon, authenticated;
grant select on public.profiles to authenticated;
grant select, insert on public.messages to authenticated;
grant update (read_at) on public.messages to authenticated;
grant select, insert, delete on public.chat_archives to authenticated;
grant select on public.communities, public.community_members, public.community_groups to authenticated;
grant select, insert on public.group_messages to authenticated;
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

  return new;
end;
$$;

drop trigger if exists on_mingle_user_created on auth.users;
create trigger on_mingle_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

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
    where (m.sender_id = auth.uid() and m.recipient_id = peers.peer_id)
       or (m.sender_id = peers.peer_id and m.recipient_id = auth.uid())
    order by m.created_at desc, m.id desc
    limit 1
  ) as latest on true
  left join lateral (
    select pg_catalog.count(*) as unread_count
    from public.messages as m
    where m.sender_id = peers.peer_id
      and m.recipient_id = auth.uid()
      and m.read_at is null
  ) as unread on true
  where (archive.peer_id is not null) = p_archived
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
  if auth.uid() is null or not exists (
    select 1
    from public.community_groups as group_chat
    join public.community_members as member on member.community_id = group_chat.community_id
    where group_chat.id = p_group_id and member.user_id = auth.uid()
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
    and message.created_at >= pg_catalog.now() - interval '15 minutes';

  if not found then
    raise exception 'This message cannot be edited. Messages can only be edited within 15 minutes.';
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
    and created_at >= pg_catalog.now() - interval '15 minutes';

  if not found then
    raise exception 'This message cannot be edited. Messages can only be edited within 15 minutes.';
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
end;
$$;
