create table if not exists public.game_hosts (
  game_id text primary key,
  host_user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists game_hosts_host_user_id_idx
  on public.game_hosts (host_user_id);

alter table public.game_hosts enable row level security;

revoke all on public.game_hosts from anon, authenticated;
grant select, insert, update, delete on public.game_hosts to service_role;
