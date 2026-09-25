-- P04: single-flight refresh lease for OAuth grants.
--
-- Refreshing must be single-flight across the whole installation, not per process:
-- two workers refreshing the same grant can each rotate the refresh token, and the
-- loser's write can erase the winner's newer token. A short lease names the worker
-- allowed to call the provider; every stored token also bumps `generation`, so the
-- write is a compare-and-swap and a stale worker cannot overwrite a newer grant.
--
-- Expand-only: two nullable columns and one partial index.

ALTER TABLE oauth_grants ADD COLUMN IF NOT EXISTS refresh_lease_owner TEXT;
ALTER TABLE oauth_grants ADD COLUMN IF NOT EXISTS refresh_lease_expires_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS oauth_grants_refresh_lease_idx
  ON oauth_grants (refresh_lease_expires_at)
  WHERE refresh_lease_expires_at IS NOT NULL;
