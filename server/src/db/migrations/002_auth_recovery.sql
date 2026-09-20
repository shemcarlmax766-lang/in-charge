-- ---------------------------------------------------------------------------
-- 002: self-service password recovery.
--
-- One row per issued one-time code. The code itself is never stored — only its
-- SHA-256 (same discipline as `sessions.token_hash`), so a database leak cannot
-- replay a live recovery. `requested_ip_hash` is deliberately a hash too: enough
-- signal to spot abuse from one address, no plaintext IP trail.
-- ---------------------------------------------------------------------------

CREATE TABLE password_resets (
    id                INTEGER PRIMARY KEY,
    user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash         TEXT NOT NULL,
    requested_ip_hash TEXT,
    delivered_to      TEXT NOT NULL,                 -- the account's own email; never user-chosen
    delivery_status   TEXT NOT NULL DEFAULT 'queued'
      CHECK (delivery_status IN ('queued','sent','outbox','failed')),
    delivery_detail   TEXT,
    attempts          INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 10),
    created_at        TEXT NOT NULL,
    expires_at        TEXT NOT NULL,
    consumed_at       TEXT,                          -- set when used, superseded or burned by too many attempts
    CHECK (datetime(expires_at) > datetime(created_at))
);

CREATE INDEX idx_pwres_user_active ON password_resets(user_id, consumed_at, expires_at);
