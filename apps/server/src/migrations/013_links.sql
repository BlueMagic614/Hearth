-- One source of truth: savings goals follow their budget category (monthly amount, and money put into it),
-- and the loan payoff plan's extra payment follows the budget's "Extra on student loans".
ALTER TABLE goals ADD COLUMN category_id TEXT REFERENCES categories(id) ON DELETE SET NULL;
ALTER TABLE loan_plans ADD COLUMN category_id TEXT REFERENCES categories(id) ON DELETE SET NULL;
