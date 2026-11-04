-- Отзыв — удаление строки: состояния «отозван» больше нет, прежние отозванные строки уходят; история отзывов — в журнале флота.
-- state: wait — приглашение выдано, ok — пропуск принят.
CREATE TABLE passes_next (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('host', 'client')),
  name TEXT NOT NULL,
  person TEXT,
  state TEXT NOT NULL CHECK (state IN ('wait', 'ok')),
  hash TEXT NOT NULL,
  by TEXT NOT NULL,
  at INTEGER NOT NULL,
  addr TEXT GENERATED ALWAYS AS (CASE role WHEN 'host' THEN '@' || name ELSE name || '~' || person END) VIRTUAL,
  CHECK (role = 'host' OR person IS NOT NULL)
);
INSERT INTO passes_next (id, role, name, person, state, hash, by, at)
  SELECT id, role, name, person, state, hash, by, at FROM passes WHERE state != 'revoked';
DROP TABLE passes;
ALTER TABLE passes_next RENAME TO passes;
-- адрес — у одного пропуска: второй → name_taken
CREATE UNIQUE INDEX one_live ON passes(addr);
