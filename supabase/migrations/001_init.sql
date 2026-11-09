-- Billiards Cup: schema, row-level security and RPC functions.
-- Everyone can READ tournaments/players/matches (you need the code to find one).
-- All WRITES go through SECURITY DEFINER functions that check a secret token
-- stored on the device (admin token or player token). No passwords, no accounts.

create table public.tournaments (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique,
  name        text not null check (char_length(name) between 1 and 60),
  format      text not null check (format in ('league_playoff', 'league', 'knockout')),
  settings    jsonb not null default '{}'::jsonb,
  status      text not null default 'lobby' check (status in ('lobby', 'league', 'playoffs', 'finished')),
  created_at  timestamptz not null default now()
);

create table public.tournament_secrets (
  tournament_id uuid primary key references public.tournaments(id) on delete cascade,
  admin_token   uuid not null default gen_random_uuid()
);

create table public.players (
  id            uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references public.tournaments(id) on delete cascade,
  name          text not null check (char_length(name) between 1 and 24),
  ball          int  not null check (ball between 1 and 8),
  is_admin      boolean not null default false,
  created_at    timestamptz not null default now()
);
create unique index players_unique_name on public.players (tournament_id, lower(name));
create index players_tournament on public.players (tournament_id);

create table public.player_secrets (
  player_id uuid primary key references public.players(id) on delete cascade,
  token     uuid not null default gen_random_uuid()
);

create table public.matches (
  id            uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references public.tournaments(id) on delete cascade,
  stage         text not null check (stage in ('league', 'playoff', 'third')),
  round         int  not null,
  slot          int  not null,
  player_a      uuid not null references public.players(id) on delete cascade,
  player_b      uuid references public.players(id) on delete cascade,
  race          int  not null check (race between 1 and 25),
  score_a       int  not null default 0,
  score_b       int  not null default 0,
  status        text not null default 'scheduled'
                check (status in ('scheduled', 'live', 'pending', 'confirmed', 'disputed')),
  table_no      int,
  reported_by   uuid references public.players(id) on delete set null,
  dispute       jsonb,
  updated_at    timestamptz not null default now(),
  unique (tournament_id, stage, round, slot)
);
create index matches_tournament on public.matches (tournament_id);

-- ---------- Row level security ----------
alter table public.tournaments        enable row level security;
alter table public.tournament_secrets enable row level security;
alter table public.players            enable row level security;
alter table public.player_secrets     enable row level security;
alter table public.matches            enable row level security;

create policy "read tournaments" on public.tournaments for select to anon, authenticated using (true);
create policy "read players"     on public.players     for select to anon, authenticated using (true);
create policy "read matches"     on public.matches     for select to anon, authenticated using (true);
-- secrets: no policies at all -> unreadable from the API
revoke all on public.tournament_secrets from anon, authenticated;
revoke all on public.player_secrets     from anon, authenticated;

-- ---------- Realtime ----------
alter publication supabase_realtime add table public.tournaments, public.players, public.matches;

-- ---------- Helpers ----------
create or replace function public._is_admin(p_tid uuid, p_token uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from tournament_secrets where tournament_id = p_tid and admin_token = p_token);
$$;

create or replace function public._player_for(p_tid uuid, p_token uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select p.id from players p join player_secrets s on s.player_id = p.id
  where p.tournament_id = p_tid and s.token = p_token;
$$;

create or replace function public._valid_result(a int, b int, race int)
returns boolean language sql immutable as $$
  select (a = race and b between 0 and race - 1) or (b = race and a between 0 and race - 1);
$$;

create or replace function public._new_code()
returns text language plpgsql volatile set search_path = public as $$
declare
  alphabet text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  c text;
begin
  loop
    c := 'BIL-';
    for i in 1..4 loop
      c := c || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
    end loop;
    exit when not exists (select 1 from tournaments where code = c);
  end loop;
  return c;
end $$;

revoke all on function public._is_admin(uuid, uuid)   from public, anon, authenticated;
revoke all on function public._player_for(uuid, uuid) from public, anon, authenticated;
revoke all on function public._new_code()             from public, anon, authenticated;

-- ---------- Public RPCs ----------

-- Create a tournament. If p_admin_name is given, the admin also plays.
create or replace function public.create_tournament(
  p_name text, p_format text, p_settings jsonb,
  p_admin_name text default null, p_admin_ball int default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  t tournaments; tok uuid; pid uuid; ptok uuid;
begin
  insert into tournaments (code, name, format, settings)
  values (_new_code(), trim(p_name), p_format, coalesce(p_settings, '{}'::jsonb))
  returning * into t;
  insert into tournament_secrets (tournament_id) values (t.id) returning admin_token into tok;
  if p_admin_name is not null and trim(p_admin_name) <> '' then
    insert into players (tournament_id, name, ball, is_admin)
    values (t.id, trim(p_admin_name), coalesce(p_admin_ball, 8), true) returning id into pid;
    insert into player_secrets (player_id) values (pid) returning token into ptok;
  end if;
  return jsonb_build_object('tournament_id', t.id, 'code', t.code, 'admin_token', tok,
                            'player_id', pid, 'player_token', ptok);
end $$;

-- Join with a code while the lobby is open.
create or replace function public.join_tournament(p_code text, p_name text, p_ball int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  t tournaments; pid uuid; ptok uuid;
begin
  select * into t from tournaments where code = upper(trim(p_code));
  if t.id is null then raise exception 'not_found'; end if;
  if t.status <> 'lobby' then raise exception 'already_started'; end if;
  if (select count(*) from players where tournament_id = t.id) >= 32 then raise exception 'full'; end if;
  if exists (select 1 from players where tournament_id = t.id and lower(name) = lower(trim(p_name))) then
    raise exception 'name_taken';
  end if;
  insert into players (tournament_id, name, ball) values (t.id, trim(p_name), p_ball) returning id into pid;
  insert into player_secrets (player_id) values (pid) returning token into ptok;
  return jsonb_build_object('tournament_id', t.id, 'code', t.code, 'player_id', pid, 'player_token', ptok);
end $$;

-- Admin removes a player (lobby only).
create or replace function public.admin_remove_player(p_tid uuid, p_admin_token uuid, p_player uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not _is_admin(p_tid, p_admin_token) then raise exception 'forbidden'; end if;
  if (select status from tournaments where id = p_tid) <> 'lobby' then raise exception 'already_started'; end if;
  delete from players where id = p_player and tournament_id = p_tid;
end $$;

-- Admin adds matches (start, next playoff round) and/or moves the tournament to a new status.
-- p_matches: [{stage, round, slot, player_a, player_b|null, race, status?, score_a?, score_b?}]
create or replace function public.admin_advance(p_tid uuid, p_admin_token uuid, p_matches jsonb, p_status text)
returns void language plpgsql security definer set search_path = public as $$
declare
  m jsonb; cur text;
begin
  if not _is_admin(p_tid, p_admin_token) then raise exception 'forbidden'; end if;
  select status into cur from tournaments where id = p_tid;
  if cur = 'finished' then raise exception 'finished'; end if;
  if cur = 'lobby' and (select count(*) from players where tournament_id = p_tid) < 2 then
    raise exception 'not_enough_players';
  end if;
  for m in select * from jsonb_array_elements(coalesce(p_matches, '[]'::jsonb)) loop
    if not exists (select 1 from players where id = (m->>'player_a')::uuid and tournament_id = p_tid)
       or ((m->>'player_b') is not null and not exists
           (select 1 from players where id = (m->>'player_b')::uuid and tournament_id = p_tid)) then
      raise exception 'bad_player';
    end if;
    insert into matches (tournament_id, stage, round, slot, player_a, player_b, race, status, score_a, score_b)
    values (p_tid, m->>'stage', (m->>'round')::int, (m->>'slot')::int,
            (m->>'player_a')::uuid, (m->>'player_b')::uuid, (m->>'race')::int,
            coalesce(m->>'status', 'scheduled'),
            coalesce((m->>'score_a')::int, 0), coalesce((m->>'score_b')::int, 0))
    on conflict (tournament_id, stage, round, slot) do nothing;
  end loop;
  update tournaments set status = p_status where id = p_tid;
end $$;

-- A player (or the admin) puts a match on a free table.
create or replace function public.start_match(p_match uuid, p_token uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  mt matches; t tournaments; me uuid; n_tables int; free int;
begin
  select * into mt from matches where id = p_match for update;
  if mt.id is null then raise exception 'not_found'; end if;
  select * into t from tournaments where id = mt.tournament_id;
  me := _player_for(t.id, p_token);
  if not (_is_admin(t.id, p_token) or me in (mt.player_a, mt.player_b)) then raise exception 'forbidden'; end if;
  if mt.status <> 'scheduled' or mt.player_b is null then raise exception 'bad_state'; end if;
  if exists (select 1 from matches where tournament_id = t.id and status = 'live'
             and (player_a in (mt.player_a, mt.player_b) or player_b in (mt.player_a, mt.player_b))) then
    raise exception 'player_busy';
  end if;
  n_tables := greatest(1, coalesce((t.settings->>'tables')::int, 1));
  select g into free from generate_series(1, n_tables) g
  where g not in (select table_no from matches where tournament_id = t.id and status = 'live' and table_no is not null)
  order by g limit 1;
  if free is null then raise exception 'no_free_table'; end if;
  update matches set status = 'live', table_no = free, score_a = 0, score_b = 0, updated_at = now() where id = p_match;
end $$;

-- Live frame counter while playing.
create or replace function public.update_live_score(p_match uuid, p_token uuid, p_a int, p_b int)
returns void language plpgsql security definer set search_path = public as $$
declare
  mt matches; me uuid;
begin
  select * into mt from matches where id = p_match for update;
  if mt.id is null then raise exception 'not_found'; end if;
  me := _player_for(mt.tournament_id, p_token);
  if not (_is_admin(mt.tournament_id, p_token) or me in (mt.player_a, mt.player_b)) then raise exception 'forbidden'; end if;
  if mt.status <> 'live' then raise exception 'bad_state'; end if;
  if p_a < 0 or p_b < 0 or p_a > mt.race or p_b > mt.race or (p_a = mt.race and p_b = mt.race) then
    raise exception 'bad_score';
  end if;
  update matches set score_a = p_a, score_b = p_b, updated_at = now() where id = p_match;
end $$;

-- Report the final result. A player's report waits for the opponent; the admin's is final.
create or replace function public.report_result(p_match uuid, p_token uuid, p_a int, p_b int)
returns void language plpgsql security definer set search_path = public as $$
declare
  mt matches; me uuid; adm boolean;
begin
  select * into mt from matches where id = p_match for update;
  if mt.id is null then raise exception 'not_found'; end if;
  adm := _is_admin(mt.tournament_id, p_token);
  me := _player_for(mt.tournament_id, p_token);
  if not (adm or me in (mt.player_a, mt.player_b)) then raise exception 'forbidden'; end if;
  if mt.player_b is null then raise exception 'bad_state'; end if;
  if not _valid_result(p_a, p_b, mt.race) then raise exception 'bad_score'; end if;
  if adm then
    update matches set score_a = p_a, score_b = p_b, status = 'confirmed', table_no = null,
           dispute = null, reported_by = null, updated_at = now() where id = p_match;
  else
    if mt.status not in ('scheduled', 'live') then raise exception 'bad_state'; end if;
    update matches set score_a = p_a, score_b = p_b, status = 'pending', table_no = null,
           reported_by = me, updated_at = now() where id = p_match;
  end if;
end $$;

-- The opponent confirms...
create or replace function public.confirm_result(p_match uuid, p_token uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  mt matches; me uuid;
begin
  select * into mt from matches where id = p_match for update;
  if mt.id is null then raise exception 'not_found'; end if;
  me := _player_for(mt.tournament_id, p_token);
  if mt.status <> 'pending' then raise exception 'bad_state'; end if;
  if me is null or me not in (mt.player_a, mt.player_b) or me = mt.reported_by then raise exception 'forbidden'; end if;
  update matches set status = 'confirmed', updated_at = now() where id = p_match;
end $$;

-- ...or disputes with their own version of the score.
create or replace function public.dispute_result(p_match uuid, p_token uuid, p_a int, p_b int)
returns void language plpgsql security definer set search_path = public as $$
declare
  mt matches; me uuid;
begin
  select * into mt from matches where id = p_match for update;
  if mt.id is null then raise exception 'not_found'; end if;
  me := _player_for(mt.tournament_id, p_token);
  if mt.status <> 'pending' then raise exception 'bad_state'; end if;
  if me is null or me not in (mt.player_a, mt.player_b) or me = mt.reported_by then raise exception 'forbidden'; end if;
  if not _valid_result(p_a, p_b, mt.race) then raise exception 'bad_score'; end if;
  update matches set status = 'disputed', dispute = jsonb_build_object('by', me, 'a', p_a, 'b', p_b),
         updated_at = now() where id = p_match;
end $$;

grant execute on function public.create_tournament(text, text, jsonb, text, int)   to anon, authenticated;
grant execute on function public.join_tournament(text, text, int)                  to anon, authenticated;
grant execute on function public.admin_remove_player(uuid, uuid, uuid)             to anon, authenticated;
grant execute on function public.admin_advance(uuid, uuid, jsonb, text)            to anon, authenticated;
grant execute on function public.start_match(uuid, uuid)                           to anon, authenticated;
grant execute on function public.update_live_score(uuid, uuid, int, int)           to anon, authenticated;
grant execute on function public.report_result(uuid, uuid, int, int)               to anon, authenticated;
grant execute on function public.confirm_result(uuid, uuid)                        to anon, authenticated;
grant execute on function public.dispute_result(uuid, uuid, int, int)              to anon, authenticated;

-- 002: pin search_path on helper (advisor fix)
alter function public._valid_result(int, int, int) set search_path = public;
