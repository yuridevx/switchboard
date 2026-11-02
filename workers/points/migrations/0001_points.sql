-- Реестр точек флота: сессии и их хозяин, точки, блоки и ссылки точек на блоки.
CREATE TABLE sessions (sid TEXT PRIMARY KEY, owner TEXT NOT NULL, head INTEGER NOT NULL);
CREATE TABLE points (
  id INTEGER PRIMARY KEY AUTOINCREMENT, sid TEXT NOT NULL, machine TEXT NOT NULL, at INTEGER NOT NULL,
  why TEXT NOT NULL, base INTEGER, callsign TEXT, dir TEXT, msgs INTEGER, bytes INTEGER,
  git TEXT, files TEXT NOT NULL, spec TEXT, last TEXT
);
CREATE INDEX points_sid ON points(sid, id);
CREATE INDEX points_base ON points(base);
CREATE TABLE blocks (hash TEXT PRIMARY KEY, size INTEGER NOT NULL);
CREATE TABLE refs (point INTEGER NOT NULL, hash TEXT NOT NULL, PRIMARY KEY (point, hash));
CREATE INDEX refs_hash ON refs(hash);
CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
