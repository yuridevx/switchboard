-- chats: чат Telegram → адрес устройства и номер его пропуска. В личке id чата равен id человека, поэтому и человек, и группа — одна строка.
CREATE TABLE chats (
  chat INTEGER PRIMARY KEY,
  addr TEXT NOT NULL,
  kid TEXT NOT NULL,
  at INTEGER NOT NULL
);
-- threads: сессия в чате → тема. Чат и тема однозначно называют сессию.
CREATE TABLE threads (
  callsign TEXT NOT NULL,
  chat INTEGER NOT NULL,
  thread INTEGER NOT NULL,
  PRIMARY KEY (callsign, chat),
  UNIQUE (chat, thread)
);
-- asks: кнопки вопроса. В callback_data Telegram помещается 64 байта, а кадр ответа несёт текст вопроса.
CREATE TABLE asks (
  chat INTEGER NOT NULL,
  message INTEGER NOT NULL,
  actions TEXT NOT NULL,
  PRIMARY KEY (chat, message)
);
