-- Приложение GitHub флота: одна строка. Ключ приложения — только здесь; в ответы, кадры и журнал не попадает.
CREATE TABLE app (
  one   INTEGER PRIMARY KEY CHECK (one = 1),
  id    INTEGER NOT NULL,
  slug  TEXT NOT NULL,
  owner TEXT NOT NULL,
  pem   TEXT NOT NULL,
  at    INTEGER NOT NULL,
  by    TEXT NOT NULL
);
