create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 40),
  phone text not null unique check (phone ~ '^[0-9]{10}$'),
  account_number text not null unique check (account_number ~ '^[0-9]{8}$'),
  created_at timestamptz not null default now()
);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references public.profiles (id) on delete cascade,
  recipient_id uuid not null references public.profiles (id) on delete cascade,
  text text not null check (char_length(btrim(text)) between 1 and 2000),
  created_at timestamptz not null default now(),
  read_at timestamptz,
  constraint messages_no_self_chat check (sender_id <> recipient_id)
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

create index if not exists profile_lookup_attempts_user_time_idx
  on public.profile_lookup_attempts (user_id, attempted_at);

alter table public.profiles enable row level security;
alter table public.messages enable row level security;
alter table public.profile_lookup_attempts enable row level security;

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

grant select on public.profiles to authenticated;
grant select, insert on public.messages to authenticated;
grant update (read_at) on public.messages to authenticated;
revoke all on public.profile_lookup_attempts from anon, authenticated;

create or replace function public.ensure_my_profile()
returns setof public.profiles
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_email text := auth.jwt() ->> 'email';
  v_name text := pg_catalog.btrim(coalesce(auth.jwt() -> 'user_metadata' ->> 'name', ''));
  v_phone text;
  v_account_number text;
  v_profile public.profiles;
  v_attempt integer;
begin
  if v_user_id is null then
    raise exception 'Please log in to continue.';
  end if;

  if v_email is null or v_email !~ '^m[0-9]{10}@accounts\.mingle\.invalid$' then
    raise exception 'This account does not use a valid Mingle mobile number.';
  end if;

  if pg_catalog.char_length(v_name) < 1 or pg_catalog.char_length(v_name) > 40 then
    raise exception 'Enter a name between 1 and 40 characters.';
  end if;

  v_phone := pg_catalog.substring(v_email, '^m([0-9]{10})@accounts\.mingle\.invalid$');

  select p.* into v_profile
  from public.profiles as p
  where p.id = v_user_id;

  if found then
    return next v_profile;
    return;
  end if;

  for v_attempt in 1..100 loop
    v_account_number := pg_catalog.lpad(
      (pg_catalog.floor(pg_catalog.random() * 100000000))::integer::text,
      8,
      '0'
    );

    begin
      insert into public.profiles (id, name, phone, account_number)
      values (v_user_id, v_name, v_phone, v_account_number)
      returning * into v_profile;

      return next v_profile;
      return;
    exception when unique_violation then
      select p.* into v_profile
      from public.profiles as p
      where p.id = v_user_id;

      if found then
        return next v_profile;
        return;
      end if;

      if exists (select 1 from public.profiles where phone = v_phone) then
        raise exception 'This mobile number already has an account. Please log in instead.';
      end if;
    end;
  end loop;

  raise exception 'Could not create an account number. Please try again.';
end;
$$;

create or replace function public.lookup_profile(p_account_number text)
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

  if p_account_number is null or p_account_number !~ '^[0-9]{8}$' then
    raise exception 'Enter an 8-digit account number.';
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
  where p.account_number = p_account_number
    and p.id <> v_user_id;
end;
$$;

create or replace function public.get_chat_summaries()
returns table (
  id uuid,
  name text,
  phone text,
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
  )
  select
    p.id,
    p.name,
    p.phone,
    p.account_number,
    p.created_at,
    latest.text,
    latest.sender_id,
    latest.created_at,
    unread.unread_count
  from peers
  join public.profiles as p on p.id = peers.peer_id
  left join lateral (
    select m.text, m.sender_id, m.created_at
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
  order by latest.created_at desc nulls last;
$$;

revoke all on function public.ensure_my_profile() from public, anon;
revoke all on function public.lookup_profile(text) from public, anon;
revoke all on function public.get_chat_summaries() from public, anon;
grant execute on function public.ensure_my_profile() to authenticated;
grant execute on function public.lookup_profile(text) to authenticated;
grant execute on function public.get_chat_summaries() to authenticated;

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
end;
$$;
