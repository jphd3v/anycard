-- Add finished_at column to track when games completed.
-- Used by backend TTL cleanup to remove stale finished-game snapshots.
ALTER TABLE game_snapshots
  ADD COLUMN IF NOT EXISTS finished_at timestamptz DEFAULT NULL;

-- Index for efficient TTL cleanup queries.
CREATE INDEX IF NOT EXISTS game_snapshots_finished_at_idx
  ON game_snapshots (finished_at)
  WHERE finished_at IS NOT NULL;
