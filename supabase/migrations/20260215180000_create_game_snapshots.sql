create table if not exists public.game_snapshots (
  game_id text primary key,
  rules_id text not null,
  snapshot jsonb not null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists game_snapshots_updated_at_idx
  on public.game_snapshots (updated_at desc);

alter table public.game_snapshots enable row level security;

revoke all on public.game_snapshots from anon, authenticated;
grant select, insert, update, delete on public.game_snapshots to service_role;
