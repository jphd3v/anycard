alter table public.game_snapshots
  add column if not exists room_type text not null default 'private';

create index if not exists game_snapshots_room_type_idx
  on public.game_snapshots (room_type);
