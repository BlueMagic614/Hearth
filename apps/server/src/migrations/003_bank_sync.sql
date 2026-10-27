-- Bank connections through Plaid (Kemba). Access tokens are encrypted with HEARTH_ENCRYPTION_KEY before storage.

CREATE TABLE bank_connections (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  provider TEXT NOT NULL DEFAULT 'plaid',
  environment TEXT NOT NULL,
  item_id TEXT NOT NULL UNIQUE,
  access_token_enc TEXT NOT NULL,
  institution_id TEXT,
  institution_name TEXT,
  cursor TEXT,
  status TEXT NOT NULL DEFAULT 'ok',
  last_error TEXT,
  last_synced_at TIMESTAMPTZ,
  last_refresh_requested_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE accounts ADD COLUMN connection_id TEXT REFERENCES bank_connections(id) ON DELETE CASCADE;
ALTER TABLE accounts ADD COLUMN external_id TEXT UNIQUE;
ALTER TABLE accounts ADD COLUMN mask TEXT;
ALTER TABLE accounts ADD COLUMN subtype TEXT;
ALTER TABLE accounts ADD COLUMN available_cents INTEGER;
ALTER TABLE accounts ADD COLUMN limit_cents INTEGER;
ALTER TABLE accounts ADD COLUMN hidden BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE transactions ADD COLUMN external_id TEXT UNIQUE;
ALTER TABLE transactions ADD COLUMN pending_external_id TEXT;
ALTER TABLE transactions ADD COLUMN raw_name TEXT;
ALTER TABLE transactions ADD COLUMN bank_category TEXT;
ALTER TABLE transactions ADD COLUMN authorized_date DATE;
ALTER TABLE transactions ADD COLUMN schedule_id TEXT;
CREATE INDEX transactions_account ON transactions(account_id);
