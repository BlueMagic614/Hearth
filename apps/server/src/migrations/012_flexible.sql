-- Bills with flexible timing (topping up the school lunch accounts): Hearth picks the payday with the most room.
ALTER TABLE schedules ADD COLUMN flexible BOOLEAN NOT NULL DEFAULT FALSE;
UPDATE schedules SET flexible = TRUE WHERE lower(name) LIKE 'student lunch%';
