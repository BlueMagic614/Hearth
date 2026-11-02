-- Cash envelopes. An ATM withdrawal is money moving into the household's shared cash pool (flow 'cash'), not
-- spending. It's split into envelopes (cash_fills); with fill-and-forget, filling an envelope counts as that
-- category's spending for the month. Cash left over at month end goes back out of the envelopes (negative fills)
-- into the Leftovers fund, and from there wherever the household decides (leftover_moves).
ALTER TABLE categories ADD COLUMN cash BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE cash_fills (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  transaction_id TEXT REFERENCES transactions(id) ON DELETE CASCADE,
  category_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
  month TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'fill',
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX cash_fills_month ON cash_fills(household_id, month);

CREATE TABLE leftover_moves (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  month TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  destination TEXT NOT NULL,
  target_id TEXT,
  target_name TEXT,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Withdrawals already synced become cash.
UPDATE transactions SET flow = 'cash' WHERE bank_category LIKE 'TRANSFER_OUT_WITHDRAWAL%' AND amount_cents < 0;

-- Everyday spending is paid in cash; tithe, rent, utilities, subscriptions, insurance and loans stay on the bank.
UPDATE categories c SET cash = TRUE
WHERE c.kind = 'everyday' AND c.months IS NULL AND NOT c.archived
  AND NOT EXISTS (SELECT 1 FROM categories k WHERE k.parent_id = c.id AND NOT k.archived);
