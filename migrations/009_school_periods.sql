-- Store each school's lesson periods so generated schedules use local bell times.
BEGIN;

CREATE TABLE IF NOT EXISTS school_periods (
  id BIGSERIAL PRIMARY KEY,
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  period_number INTEGER NOT NULL CHECK (period_number BETWEEN 1 AND 30),
  name TEXT NOT NULL,
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  CONSTRAINT school_periods_valid_interval CHECK (end_time > start_time),
  CONSTRAINT school_periods_school_period_unique UNIQUE (school_id, period_number)
);

COMMIT;
