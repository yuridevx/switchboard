-- Настройки: строка на ключ; в колонке user — владелец строки: почта, global или app:<приложение>. Служебных данных флота здесь нет.
CREATE TABLE prefs (
  user  TEXT NOT NULL,
  key   TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (user, key)
);
