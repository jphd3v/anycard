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
`supabase/migrations/20260215180000_create_game_snapshots.sql` and applies the
latest migrations (including room type, finished timestamp, identity tables,
and host ownership table).

## 3. Configure backend environment

Set these in `backend/.env` (never in frontend env files):

```bash
SUPABASE_AUTOSAVE_ENABLED=true
SUPABASE_URL=https://<your-project-ref>.supabase.co
SUPABASE_SECRET_KEY=<supabase-secret-key>
# optional (default: game_snapshots)
SUPABASE_AUTOSAVE_TABLE=game_snapshots
# optional (identity + seat ownership)
SUPABASE_IDENTITY_ENABLED=true
# optional (defaults shown)
SEAT_CLAIM_RELEASE_TIMEOUT_SECONDS=600
SEAT_CLAIM_CLEANUP_INTERVAL_MS=60000
```

If identity is enabled, set frontend public keys in `frontend/.env`:

```bash
VITE_SUPABASE_URL=https://<your-project-ref>.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=<supabase-public-key>
```

## 4. Security best practices

- Use `SUPABASE_SECRET_KEY` **only** in backend runtime.
- Never expose Supabase secret keys to browser code.
- Never commit `.env` files with real keys.
- Rotate the key immediately if leaked.
- Keep `SUPABASE_AUTOSAVE_ENABLED=false` in environments where you do not want
  autosave writes.

## 5. Runtime behavior

- Autosave subscribes to backend state changes.
- On state changes, snapshot is upserted by `game_id`.
- `room_type` is persisted (`demo`, `public`, or `private`) with each snapshot.
- Snapshots are retained by default (no automatic delete on game close).
- On backend startup, persisted snapshots are restored into active in-memory
  games (using the same `game_id`).
- Finished snapshots are cleaned up automatically after 7 days.
- Seat claims are marked disconnected on leave/disconnect and released after the
  configured timeout (default: 10 minutes).
- Backend runs a Supabase schema preflight at startup.
- When `SUPABASE_AUTOSAVE_ENABLED=true` and Supabase credentials are set, a
  missing required schema (for example `room_type`) is treated as a startup
  error and backend exits fast. This prevents running in a degraded state.
- Export/import buttons and JSON save flow continue to work.

## 6. Privacy baseline (identity mode)

- Identity mode supports:
  - guest IDs persisted in browser local storage (`guest-id`)
  - optional Supabase email magic-link auth (`auth.users.id`)
- Backend persists only:
  - seat ownership (`seat_claims.owner_user_id`)
  - optional emoji avatar
  - room host (`game_hosts.host_user_id`)
- Frontend local storage stores gameplay hints (`player-id`, `recent-games`) and
  Supabase session data when identity mode is enabled.
