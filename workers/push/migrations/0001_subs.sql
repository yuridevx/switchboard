-- Подписки на уведомления: строка на устройство (адрес клиента), kid — номер пропуска, которым подписались.
CREATE TABLE subs (
  client   TEXT PRIMARY KEY,
  endpoint TEXT NOT NULL,
  p256dh   TEXT NOT NULL,
  auth     TEXT NOT NULL,
  at       INTEGER NOT NULL,
  kid      TEXT
);
