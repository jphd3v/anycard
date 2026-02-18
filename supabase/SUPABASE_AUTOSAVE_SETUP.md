# Supabase Autosave Setup

This project supports optional backend autosave to Supabase.

If autosave is not enabled, or credentials are missing, backend behavior is
unchanged and game state stays in memory exactly as before.

## 1. Install Supabase CLI

Choose one:

```bash
# macOS (Homebrew)
brew install supabase/tap/supabase

# cross-platform without global install
npx supabase --version
```

You can also use the npm scripts in this repo:

```bash
npm run supabase:init
npm run supabase:login
npm run supabase:link
npm run supabase:db:push
```

## 2. Initialize and link this repo

```bash
# from repo root
npm run supabase:init
npm run supabase:login
npm run supabase:link -- --project-ref <your-project-ref>
```

Then apply migrations:

```bash
npm run supabase:db:push
```

This creates `public.game_snapshots` from
`supabase/migrations/20260215180000_create_game_snapshots.sql` and applies
`supabase/migrations/20260215210000_add_room_type_to_game_snapshots.sql`.

## 3. Configure backend environment

Set these in `backend/.env` (never in frontend env files):

```bash
SUPABASE_AUTOSAVE_ENABLED=true
SUPABASE_URL=https://<your-project-ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service-role-key>
# optional (default: game_snapshots)
SUPABASE_AUTOSAVE_TABLE=game_snapshots
```

## 4. Security best practices

- Use `SUPABASE_SERVICE_ROLE_KEY` **only** in backend runtime.
- Never expose service-role key to browser code.
- Never commit `.env` files with real keys.
- Rotate the service-role key immediately if leaked.
- Keep `SUPABASE_AUTOSAVE_ENABLED=false` in environments where you do not want
  autosave writes.

## 5. Runtime behavior

- Autosave subscribes to backend state changes.
- On state changes, snapshot is upserted by `game_id`.
- `room_type` is persisted (`demo`, `public`, or `private`) with each snapshot.
- Snapshots are retained by default (no automatic delete on game close).
- On backend startup, persisted snapshots are restored into active in-memory
  games (using the same `game_id`).
- Backend runs a Supabase schema preflight at startup.
- When `SUPABASE_AUTOSAVE_ENABLED=true` and Supabase credentials are set, a
  missing required schema (for example `room_type`) is treated as a startup
  error and backend exits fast. This prevents running in a degraded state.
- Export/import buttons and JSON save flow continue to work.
