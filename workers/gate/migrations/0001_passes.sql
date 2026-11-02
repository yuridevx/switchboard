-- Пропуска флота: строка на пропуск, ключ — номер. Секретов нет — только sha256.
-- state: wait — приглашение выдано, ok — пропуск принят, revoked — отозван.
-- addr вычисляет база: у машины @имя, у устройства и программы имя~человек.
CREATE TABLE passes (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('host', 'client')),
  name TEXT NOT NULL,
  person TEXT,
  state TEXT NOT NULL CHECK (state IN ('wait', 'ok', 'revoked')),
  hash TEXT NOT NULL,
  by TEXT NOT NULL,
  at INTEGER NOT NULL,
  addr TEXT GENERATED ALWAYS AS (CASE role WHEN 'host' THEN '@' || name ELSE name || '~' || person END) VIRTUAL,
  CHECK (role = 'host' OR person IS NOT NULL)
);

-- адрес — у одного живого пропуска: второй → name_taken
CREATE UNIQUE INDEX one_live ON passes(addr) WHERE state IN ('wait', 'ok');
