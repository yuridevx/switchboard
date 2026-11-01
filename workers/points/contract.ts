// Контракт points: реестр точек сессий с пометкой «в R2» и временные ключи R2 на блоки точек.
// Запросы — кадры с to: ".points", ответ — reply через relay. Байтов точек points не видит.

export const CONTRACT = { "points.put": 1, "points.get": 1, "points.list": 1, "points.delete": 1 } as const;

/** Файл точки: путь относительно папки проектов Claude, размер и отпечатки блоков (SHA-256, hex) по порядку. */
export type PointFile = { p: string; size: number; b: string[] };

/** rule — правило, save — по запросу и при пометке «в R2», start — старт Host, raise — подъём, yield — отдаёт сессию. */
export type Why = "rule" | "save" | "start" | "raise" | "yield";

/**
 * points.put — точка готова (или «каких блоков нет?»). Шлёт только машина.
 * raise: base — из какой точки, expect — кто хозяин сейчас; by — кто попросил: для журнала флота.
 * Новый sid с base из другой сессии — копия.
 */
export type PointsPut = {
  type: "points.put";
  id: string;
  v?: 1;
  to: ".points";
  sid: string;
  why: Why;
  files: PointFile[];
  callsign?: string;
  dir?: string;
  msgs?: number;
  bytes?: number;
  git?: Record<string, unknown>;
  spec?: Record<string, unknown>;
  last?: unknown[];
  base?: number;
  expect?: string;
  by?: string;
};
/** ok: id новой точки; same — файлы те же, что у основы: строки нет, id — основа. */
export type PointsPutResult = { id: number; same?: true };

/** Временный ключ R2 на час: машина шлёт его в S3, sessionToken — заголовком X-Amz-Security-Token. */
export type Creds = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  endpoint: string;
  bucket: string;
  /** до какого времени ключ годен, мс */
  exp: number;
};

/** Точка целиком — строка реестра. */
export type Point = {
  id: number;
  sid: string;
  machine: string;
  at: number;
  why: Why;
  base: number | null;
  files: PointFile[];
  callsign?: string;
  dir?: string;
  msgs?: number;
  bytes?: number;
  git?: Record<string, unknown>;
  spec?: Record<string, unknown>;
  last?: unknown[];
};

/** points.get — строки точек целиком и хозяин; машине — ещё ключ R2 на чтение f/. */
export type PointsGet = { type: "points.get"; id: string; v?: 1; to: ".points"; ids: number[] };
export type PointsGetResult = { owner: string; points: Point[]; creds?: Creds };

/** points.list — без sid: обзор флота; с sid: точки сессии, line и until считает points. */
export type PointsList = { type: "points.list"; id: string; v?: 1; to: ".points"; sid?: string };
export type ListedPoint = Omit<Point, "files" | "spec" | "last" | "sid"> & { line: boolean; until: number | null };
export type PointsListSession = { owner: string | null; head: number | null; points: ListedPoint[] };
export type PointsListFleet = {
  sessions: Array<{ sid: string; callsign?: string; dir?: string; owner: string; head: { id: number; at: number }; points: number; branches: number }>;
  r2: { bytes: number; blocks: number };
  sweep: { at: number; blocks: number; bytes: number } | null;
};

/** points.delete — стереть точки сессии и сразу убрать из R2 её блоки без ссылок. Отмены нет. */
export type PointsDelete = { type: "points.delete"; id: string; v?: 1; to: ".points"; sid: string; by?: string };
export type PointsDeleteResult = { points: number; blocks: number; bytes: number };

/**
 * Слова отказа points. missing несёт missing (каких блоков нет) и creds на запись f/;
 * not_owner — owner; no_point — ids.
 */
export type PointsWord = "missing" | "not_owner" | "no_point" | "r2_failed";
