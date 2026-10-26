-- Hearth core schema. All money columns are integer cents.

CREATE TABLE households (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT,
  must_change_password BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL
);

-- Category tree: any depth via parent_id. Only leaves carry planned money.
CREATE TABLE categories (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES categories(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  archived BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX categories_household ON categories(household_id);

-- Planned amount per category per month (YYYY-MM). Missing months carry forward from the latest earlier month.
CREATE TABLE budgets (
  category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  month TEXT NOT NULL,
  planned_cents INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (category_id, month)
);

CREATE TABLE income_sources (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  person TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  cadence TEXT NOT NULL,
  days INTEGER[] NOT NULL DEFAULT '{}',
  weekend_rule TEXT NOT NULL DEFAULT 'before'
);

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  institution TEXT,
  balance_cents INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE transactions (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  date DATE NOT NULL,
  amount_cents INTEGER NOT NULL,
  merchant TEXT NOT NULL,
  category_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
  source TEXT NOT NULL DEFAULT 'manual',
  confidence REAL,
  pending BOOLEAN NOT NULL DEFAULT FALSE,
  note TEXT,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX transactions_household_date ON transactions(household_id, date);

-- Repeating bills, paydays and savings moves.
CREATE TABLE schedules (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  cadence TEXT NOT NULL,
  days INTEGER[] NOT NULL DEFAULT '{}',
  weekday INTEGER,
  weekend_rule TEXT NOT NULL DEFAULT 'none',
  variable BOOLEAN NOT NULL DEFAULT FALSE,
  due_day_confirmed BOOLEAN NOT NULL DEFAULT FALSE,
  category_id TEXT REFERENCES categories(id) ON DELETE SET NULL
);

CREATE TABLE loans (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  balance_cents INTEGER NOT NULL,
  apr DOUBLE PRECISION NOT NULL,
  min_payment_cents INTEGER NOT NULL,
  as_of DATE NOT NULL
);

CREATE TABLE loan_plans (
  household_id TEXT PRIMARY KEY REFERENCES households(id) ON DELETE CASCADE,
  strategy TEXT NOT NULL DEFAULT 'snowball',
  extra_cents INTEGER NOT NULL DEFAULT 0,
  start_month TEXT NOT NULL
);

CREATE TABLE goals (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  target_cents INTEGER NOT NULL DEFAULT 0,
  saved_cents INTEGER NOT NULL DEFAULT 0,
  monthly_cents INTEGER NOT NULL DEFAULT 0,
  target_month TEXT,
  horizon TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0
);

-- One-time income (bonus, stock sale, refund) and raises.
CREATE TABLE income_events (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'one_time',
  month TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  destination TEXT NOT NULL DEFAULT 'loans',
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  repeats_yearly BOOLEAN NOT NULL DEFAULT FALSE,
  note TEXT,
  actual_cents INTEGER,
  matched_transaction_id TEXT REFERENCES transactions(id) ON DELETE SET NULL
);

CREATE TABLE settings (
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value JSONB NOT NULL,
  PRIMARY KEY (household_id, key)
);
