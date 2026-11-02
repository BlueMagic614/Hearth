-- Money that comes out of a check on payday itself (tithe, savings moves, extra debt payments assigned to a check).
-- A bill merely due on a payday is paid by the earlier check; these are paid by that day's check.
ALTER TABLE schedules ADD COLUMN on_payday BOOLEAN NOT NULL DEFAULT FALSE;
UPDATE schedules s SET on_payday = TRUE FROM categories c WHERE c.id = s.category_id AND c.kind = 'giving';
