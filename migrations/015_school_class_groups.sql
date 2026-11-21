CREATE TABLE IF NOT EXISTS public.school_class_groups (
  id BIGSERIAL PRIMARY KEY,
  school_id UUID NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  class_group TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_school_class_groups_school_name
  ON public.school_class_groups (school_id, lower(btrim(class_group)));
