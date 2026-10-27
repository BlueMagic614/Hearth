-- Due dates: where each schedule's date comes from, how much it wanders, and one-off moves.

-- placeholder = not yet known; manual = set by a person; learned = inferred from bank history.
ALTER TABLE schedules ADD COLUMN date_source TEXT NOT NULL DEFAULT 'placeholder';
-- How many days either side of the expected date the payment usually lands (learned from history).
ALTER TABLE schedules ADD COLUMN window_days INTEGER NOT NULL DEFAULT 0;
ALTER TABLE income_sources ADD COLUMN date_source TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE income_sources ADD COLUMN window_days INTEGER NOT NULL DEFAULT 0;

-- A single occurrence moved to another day ("just this month").
CREATE TABLE schedule_overrides (
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  schedule_id TEXT NOT NULL,
  original_date DATE NOT NULL,
  new_date DATE NOT NULL,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (schedule_id, original_date)
);

-- Seeded tithe and paydays are known dates.
UPDATE schedules SET date_source = 'manual' WHERE due_day_confirmed = TRUE;
