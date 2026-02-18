create table if not exists public.user_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  avatar_emoji text,
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.seat_claims (
  game_id text not null,
  seat_id text not null,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  avatar_emoji text,
  disconnected_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (game_id, seat_id)
);

create index if not exists seat_claims_game_id_idx
  on public.seat_claims (game_id);

create index if not exists seat_claims_owner_user_id_idx
  on public.seat_claims (owner_user_id);

create index if not exists seat_claims_disconnected_at_idx
  on public.seat_claims (disconnected_at);

alter table public.user_profiles enable row level security;
alter table public.seat_claims enable row level security;

revoke all on public.user_profiles from anon, authenticated;
revoke all on public.seat_claims from anon, authenticated;
grant select, insert, update, delete on public.user_profiles to service_role;
grant select, insert, update, delete on public.seat_claims to service_role;
