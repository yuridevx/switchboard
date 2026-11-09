// Контракт points: архив сессий флота — реестр точек с пометкой «в архиве», каталог и поиск, разговор точки.
// Блоки точек лежат в хранилище флота (контракт blocks): ссылки на них points берёт у хранилища и отдаёт машине и CLI; байтов не видит.
// Запросы — кадры с to: ".points", прямым POST с пропуском или через relay.

export const CONTRACT = { "points.put": 3, "points.get": 2, "points.list": 2, "points.delete": 1 } as const;

/** Файл точки: путь относительно папки проектов Claude, размер и отпечатки блоков (SHA-256, hex) по порядку. */
export type PointFile = { p: string; size: number; b: string[] };

/** rule — правило, save — по запросу и при пометке «в архиве», start — старт Host, raise — подъём, yield — отдаёт сессию. */
export type Why = "rule" | "save" | "start" | "raise" | "yield";

/** Сводка сессии на точке: заголовок (getSessionInfo SDK), модель последнего ответа и токены основной нити. */
export type Summary = { title?: string; model?: string; tok_in?: number; tok_out?: number };

/**
 * points.put — точка готова (или «каких блоков нет?»). Шлёт только машина.
 * raise: base — из какой точки, expect — кто хозяин сейчас; by — кто попросил: для журнала флота.
 * Новый sid с base из другой сессии — копия.
 */
export type PointsPut = Summary & {
  type: "points.put";
  id: string;
  v?: 3;
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
  base?: number;
  expect?: string;
  by?: string;
};
/** ok: id новой точки; same — файлы те же, что у основы: строки нет, id — основа. */
export type PointsPutResult = { id: number; same?: true };

/** Ссылки на блоки по отпечатку: один блок, один метод (PUT или GET), час; машина идёт по ссылке без ключа. */
export type Links = Record<string, string>;

/** Точка целиком — строка реестра. */
export type Point = Summary & {
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
};

/** points.get — строки точек целиком и хозяин; машине — ещё ссылки GET на блоки этих точек. */
export type PointsGet = { type: "points.get"; id: string; v?: 2; to: ".points"; ids: number[] };
export type PointsGetResult = { owner: string; points: Point[]; links?: Links };

/**
 * points.list — с sid: точки сессии, line и until считает points. Без sid: каталог архива из реестра; с q — сессии, где в разговоре
 * последней точки есть q (через хранилище; хранилище без поиска — отказ no_search). since — ISO, order — last (по времени) или tokens.
 */
export type PointsList = { type: "points.list"; id: string; v?: 2; to: ".points"; sid?: string; q?: string; since?: string; order?: "last" | "tokens"; limit?: number };
export type ListedPoint = Omit<Point, "files" | "spec" | "sid"> & { line: boolean; until: number | null };
export type PointsListSession = { owner: string | null; head: number | null; points: ListedPoint[] };
/** Совпадение поиска: запись разговора (uuid, время) в точке и отрывок текста. */
export type Hit = { uuid: string; point: number; at: string; text: string };
export type Listed = Summary & { sid: string; callsign?: string; dir?: string; owner: string; head: { id: number; at: number }; points: number; branches: number; hits?: Hit[] };
/** search — умеет ли хранилище флота искать: страница прячет поле поиска. */
export type PointsListFleet = {
  search: boolean;
  sessions: Listed[];
  store: { bytes: number; blocks: number };
  sweep: { at: number; blocks: number; bytes: number } | null;
};

/** points.delete — стереть точки сессии и сразу убрать из хранилища её блоки без ссылок. Отмены нет. */
export type PointsDelete = { type: "points.delete"; id: string; v?: 1; to: ".points"; sid: string; by?: string };
export type PointsDeleteResult = { points: number; blocks: number; bytes: number };

/**
 * Слова отказа points. missing несёт missing (каких блоков нет) и links — ссылки PUT на каждый;
 * not_owner — owner; no_point — ids; no_search — хранилище флота не ищет; store_failed — хранилище не ответило.
 */
export type PointsWord = "missing" | "not_owner" | "no_point" | "no_search" | "store_failed";
