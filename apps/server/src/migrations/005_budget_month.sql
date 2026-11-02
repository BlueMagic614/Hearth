-- The month a payment counts toward, when it differs from the month it cleared (rent paid on the 31st for
-- the 1st). NULL means the month of its date.
ALTER TABLE transactions ADD COLUMN budget_month TEXT;
