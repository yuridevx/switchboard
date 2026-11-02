-- Журнал флота: строка на запись, номер — курсор чтения. Записи не удаляются.
CREATE TABLE events (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  t        INTEGER NOT NULL,
  ev       TEXT NOT NULL,
  "from"   TEXT NOT NULL,
  by       TEXT,
  machine  TEXT,
  callsign TEXT,
  text     TEXT NOT NULL
);
CREATE INDEX events_m ON events(machine, id);
