-- Native MCP authorization is separate from browser sessions and DAV passwords.
-- Run after 0166, before rolling out the MCP-enabled backend.
CREATE TABLE mcp_clients (
  id TEXT PRIMARY KEY,
  metadata_encrypted TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE mcp_grants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id TEXT REFERENCES mcp_clients(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  scopes TEXT[] NOT NULL,
  restrictions JSONB NOT NULL,
  require_confirmation BOOLEAN NOT NULL DEFAULT true,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ,
  UNIQUE(id, user_id)
);
CREATE INDEX mcp_grants_user ON mcp_grants(user_id, created_at DESC);
CREATE TABLE mcp_authorizations (
  id_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES mcp_clients(id) ON DELETE CASCADE,
  request_encrypted TEXT NOT NULL,
  grant_id UUID REFERENCES mcp_grants(id) ON DELETE CASCADE,
  code_hash TEXT UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '10 minutes',
  consumed_at TIMESTAMPTZ
);
CREATE INDEX mcp_authorizations_expiry ON mcp_authorizations(expires_at);
CREATE TABLE mcp_tokens (
  token_hash TEXT PRIMARY KEY,
  grant_id UUID NOT NULL REFERENCES mcp_grants(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('access','refresh','personal')),
  scopes TEXT[] NOT NULL,
  resource TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX mcp_tokens_grant ON mcp_tokens(grant_id);
CREATE INDEX mcp_tokens_expiry ON mcp_tokens(expires_at);
CREATE TABLE mcp_operations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  grant_id UUID NOT NULL,
  user_id UUID NOT NULL,
  request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128),
  tool TEXT NOT NULL,
  arguments_hash TEXT NOT NULL,
  arguments_encrypted TEXT NOT NULL,
  result_encrypted TEXT,
  state TEXT NOT NULL CHECK (state IN ('pending','approved','executing','succeeded','failed','uncertain','denied')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '30 minutes',
  approved_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  FOREIGN KEY(grant_id, user_id) REFERENCES mcp_grants(id, user_id) ON DELETE CASCADE,
  UNIQUE(grant_id, request_id)
);
CREATE INDEX mcp_operations_user ON mcp_operations(user_id, created_at DESC);
-- Operation receipts are intentionally retained while their grant exists. Deleting
-- them could turn a replayed request ID into a second external side effect.
