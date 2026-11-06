-- Ключи API флота: строка на ключ. env и settings — JSON в родном формате Claude, модуль их не читает.
CREATE TABLE keys (
  name     TEXT PRIMARY KEY,
  env      TEXT NOT NULL,
  settings TEXT NOT NULL,
  key      TEXT NOT NULL
);
