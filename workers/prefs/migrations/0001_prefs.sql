-- Настройки пользователя: строка на ключ. Служебных данных флота здесь нет.
CREATE TABLE prefs (
  user  TEXT NOT NULL,
  key   TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (user, key)
);
