-- Contractor authentication and tenant isolation.
--
-- Dashboard access is granted by an explicit organization_members row. There is
-- no implicit access: a user with no membership can read nothing, and the API
-- derives the set of permitted organizations from the session on every request
-- rather than trusting an organization_id sent by the browser.
--
-- Homeowner access is deliberately NOT modelled here. Home Records stay on the
-- separate, capability-style home_record_access.token so that a homeowner link
-- can never become a contractor session.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  -- Lower-cased copy of email; uniqueness must be case-insensitive so that
  -- Owner@x.com cannot be registered alongside owner@x.com.
  email_normalized TEXT NOT NULL UNIQUE,
  name TEXT,
  -- Encoded as pbkdf2$<iterations>$<salt_b64>$<hash_b64>. The iteration count
  -- travels with the hash so it can be raised later without invalidating
  -- existing credentials.
  password_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
  last_login_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS organization_members (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('owner','admin','member')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE (organization_id, user_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  -- SHA-256 of the opaque cookie value, never the value itself, so that read
  -- access to D1 does not hand over live sessions.
  token_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  user_agent TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_members_user ON organization_members(user_id);
CREATE INDEX IF NOT EXISTS idx_members_org ON organization_members(organization_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
