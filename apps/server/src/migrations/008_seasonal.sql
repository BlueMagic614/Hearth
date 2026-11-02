-- Categories and bills that only happen in certain months (yearly registration, school fees...). NULL = every month.
ALTER TABLE categories ADD COLUMN months INTEGER[];
ALTER TABLE schedules ADD COLUMN months INTEGER[];

-- Car registration is yearly, due May 29: shown only in May, amount entered then.
UPDATE categories SET months = '{5}' WHERE lower(name) LIKE 'car registration%' AND NOT archived;
DELETE FROM budgets WHERE month NOT LIKE '%-05' AND category_id IN (SELECT id FROM categories WHERE lower(name) LIKE 'car registration%' AND months IS NOT NULL);
INSERT INTO schedules (id, household_id, name, kind, amount_cents, cadence, days, months, weekend_rule, variable, category_id, date_source, window_days)
SELECT gen_random_uuid()::text, c.household_id, 'Car registration', 'bill', 0, 'monthly', '{29}', '{5}', 'none', FALSE, c.id, 'manual', 0
FROM categories c
WHERE lower(c.name) LIKE 'car registration%' AND c.months IS NOT NULL AND NOT EXISTS (SELECT 1 FROM schedules s WHERE s.category_id = c.id);
