-- Phase 3: categorization agent. Transactions say whether they are spending, income or a transfer between
-- the household's own accounts; uncertain ones wait in a review list with the agent's best guess.
ALTER TABLE transactions ADD COLUMN flow TEXT NOT NULL DEFAULT 'spend';
ALTER TABLE transactions ADD COLUMN needs_review BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE transactions ADD COLUMN suggested_category_id TEXT REFERENCES categories(id) ON DELETE SET NULL;
CREATE INDEX transactions_review ON transactions(household_id) WHERE needs_review;

UPDATE transactions SET flow = 'income' WHERE bank_category LIKE 'INCOME%';
UPDATE transactions SET flow = 'transfer' WHERE bank_category LIKE 'TRANSFER_IN%' OR bank_category LIKE 'TRANSFER_OUT%';

-- What the household (or Claude) decided about a payee, keyed by its normalized name.
CREATE TABLE payee_hints (
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  merchant_key TEXT NOT NULL,
  category_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
  flow TEXT,
  confidence REAL,
  source TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (household_id, merchant_key)
);
