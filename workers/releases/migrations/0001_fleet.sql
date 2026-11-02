-- Выпуски флота: одна строка — stable (часть → версия), отличия планов машин (машина → часть → запись) и одна rev.
-- Правка — UPDATE … WHERE rev = прочитанная: вторая одновременная не находит строку — conflict.
CREATE TABLE fleet (
  one    INTEGER PRIMARY KEY CHECK (one = 1),
  stable TEXT NOT NULL,
  plans  TEXT NOT NULL,
  rev    INTEGER NOT NULL
);
INSERT INTO fleet (one, stable, plans, rev) VALUES (1, '{}', '{}', 0);
