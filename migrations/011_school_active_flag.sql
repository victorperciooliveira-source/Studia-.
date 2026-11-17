ALTER TABLE schools
  ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true;

UPDATE schools
SET active = false
WHERE name NOT ILIKE '%Szymanski%';

INSERT INTO schools (name)
VALUES ('Colégio Estadual Prof. Júlio Szymanski')
ON CONFLICT (name) DO NOTHING;

UPDATE schools
SET active = true
WHERE name = 'Colégio Estadual Prof. Júlio Szymanski';

UPDATE schools
SET active = false
WHERE name <> 'Colégio Estadual Prof. Júlio Szymanski';

UPDATE users AS account
SET school_id = (
  SELECT id
  FROM schools
  WHERE name = 'Colégio Estadual Prof. Júlio Szymanski'
)
WHERE account.role IN ('teacher', 'diretor')
  AND (
    account.school_id IS NULL
    OR NOT EXISTS (
      SELECT 1
      FROM schools
      WHERE schools.id = account.school_id
        AND schools.active = true
    )
  );
