-- When Kemba last handed Plaid new data (from Plaid's item status), so the app can say how fresh things are.
ALTER TABLE bank_connections ADD COLUMN bank_updated_at TIMESTAMPTZ;
