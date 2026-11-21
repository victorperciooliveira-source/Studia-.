CREATE TABLE IF NOT EXISTS public.teacher_class_groups (
  id BIGSERIAL PRIMARY KEY,
  school_id UUID NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  teacher_id UUID NOT NULL REFERENCES public.users(uid) ON DELETE CASCADE,
  class_group TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_teacher_class_groups_teacher_class
  ON public.teacher_class_groups (teacher_id, lower(btrim(class_group)));

CREATE UNIQUE INDEX IF NOT EXISTS idx_teacher_class_groups_exact
  ON public.teacher_class_groups (school_id, teacher_id, class_group);
