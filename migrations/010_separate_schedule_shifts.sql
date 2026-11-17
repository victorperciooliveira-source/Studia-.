-- Separate periods and schedules by school shift.
BEGIN;

ALTER TABLE school_periods
  ADD COLUMN IF NOT EXISTS turno TEXT NOT NULL DEFAULT 'manha';

ALTER TABLE school_periods
  DROP CONSTRAINT IF EXISTS school_periods_turno_check,
  ADD CONSTRAINT school_periods_turno_check
    CHECK (turno IN ('manha', 'tarde', 'noite'));

ALTER TABLE school_periods
  DROP CONSTRAINT IF EXISTS school_periods_period_number_check,
  ADD CONSTRAINT school_periods_period_number_check
    CHECK (period_number BETWEEN 1 AND 6);

ALTER TABLE school_periods
  DROP CONSTRAINT IF EXISTS school_periods_turno_period_limit_check,
  ADD CONSTRAINT school_periods_turno_period_limit_check
    CHECK ((turno IN ('manha', 'tarde') AND period_number <= 6)
      OR (turno = 'noite' AND period_number <= 5));

ALTER TABLE school_periods
  DROP CONSTRAINT IF EXISTS school_periods_school_period_unique;

ALTER TABLE school_periods
  DROP CONSTRAINT IF EXISTS school_periods_school_turno_period_unique,
  ADD CONSTRAINT school_periods_school_turno_period_unique
    UNIQUE (school_id, turno, period_number);

ALTER TABLE schedules
  ADD COLUMN IF NOT EXISTS turno TEXT;

UPDATE schedules
SET turno = CASE
  WHEN starttime::time >= TIME '05:00'
    AND starttime::time < TIME '12:00' THEN 'manha'
  WHEN starttime::time >= TIME '12:00'
    AND starttime::time < TIME '18:00' THEN 'tarde'
  ELSE 'noite'
END
WHERE turno IS NULL;

ALTER TABLE schedules
  ALTER COLUMN turno SET DEFAULT 'manha',
  ALTER COLUMN turno SET NOT NULL,
  DROP CONSTRAINT IF EXISTS schedules_turno_check,
  ADD CONSTRAINT schedules_turno_check
    CHECK (turno IN ('manha', 'tarde', 'noite'));

CREATE INDEX IF NOT EXISTS idx_schedules_school_turno_date
  ON schedules (school_id, turno, date);

COMMIT;
