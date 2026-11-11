-- Вид пропуска — форма адреса: адрес хранится как выдан (@laptop, pult~ann@example.com, site@laptop), роль и имя уходят;
-- грамматику адреса знает только protocol. owner — владелец машины (~почта): у устройства владелец — в адресе после ~.
-- Владелец прежних машин — человек, чьё устройство выдало приглашение (by), иначе неизвестен.
-- challenge, client, back — у приглашения согласия OAuth: PKCE S256, описание клиента и адрес возврата.
-- state: wait — приглашение выдано (живёт 24 часа), ok — пропуск принят.
CREATE TABLE passes_next (
  id TEXT PRIMARY KEY,
  addr TEXT NOT NULL,
  owner TEXT,
  state TEXT NOT NULL CHECK (state IN ('wait', 'ok')),
  hash TEXT NOT NULL,
  by TEXT NOT NULL,
  at INTEGER NOT NULL,
  challenge TEXT,
  client TEXT,
  back TEXT
);
INSERT INTO passes_next (id, addr, owner, state, hash, by, at)
  SELECT id, addr, CASE WHEN role = 'host' AND instr(by, '~') > 0 THEN substr(by, instr(by, '~')) END, state, hash, by, at FROM passes;
DROP TABLE passes;
ALTER TABLE passes_next RENAME TO passes;
-- адрес — у одного пропуска: второй → name_taken
CREATE UNIQUE INDEX one_live ON passes(addr);
