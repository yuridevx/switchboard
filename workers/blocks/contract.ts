// Контракт хранилища блоков точек. blocks — модуль-контракт: имена и типы без кода; исполняют его blocks-r2 и blocks-ch, во флоте стоит
// одна реализация под именем службы switchboard-blocks. Зовёт только points — привязкой STORE (entrypoint Blocks, метод frame); клиентам не виден.
// Блок — часть файла точки: имя — SHA-256 содержимого (hex), тело по ссылке — zstd. Ссылки — Host и CLI, они ходят в хранилище сами, мимо points.
// Формата разговора хранилище не знает: кто сессия и где сообщение, решает points.

export const CONTRACT = { "blocks.links": 1, "blocks.drop": 1, "blocks.search": 1 } as const;

/** Имя службы хранилища и вход привязки: у обеих реализаций одни. */
export const SERVICE = "switchboard-blocks";
export const ENTRYPOINT = "Blocks";

/** Отпечаток блока — hex SHA-256. */
export const HASH = /^[0-9a-f]{64}$/;

/**
 * blocks.links — ссылки на блоки по отпечатку, одна на блок, час. PUT отдаёт ещё have — блоки, что уже лежат, с размером;
 * ссылки PUT — только на остальные.
 */
export type BlocksLinks = { type: "blocks.links"; id: string; v?: 1; method: "PUT" | "GET"; hashes: string[] };
export type BlocksLinksResult = { have?: Record<string, number>; links: Record<string, string> };

/** blocks.drop — убрать блоки по отпечаткам одним запросом; каких нет — не считаются. */
export type BlocksDrop = { type: "blocks.drop"; id: string; v?: 1; hashes: string[] };
export type BlocksDropResult = { blocks: number; bytes: number };

/** blocks.search — строки с q без учёта регистра в названных блоках, по одной на блок. Хранилище без поиска — отказ no_search. */
export type BlocksSearch = { type: "blocks.search"; id: string; v?: 1; q: string; hashes: string[]; limit: number };
export type BlocksSearchResult = Array<{ hash: string; line: string }>;

/** Слова отказа: bad_frame — поля не того вида; no_search — хранилище не ищет; store_failed — хранилище не ответило. */
export type BlocksWord = "bad_frame" | "no_search" | "store_failed";

/** Чтение блока по ссылке — одно у всех, кто ходит в хранилище сам: points.history, подъём Host, pull. */
export { BlockError, fetchBlock, fetchFiles, sha256 } from "./block.ts";

/** Стенд для тестов соседей: хранилище в памяти под именем службы. */
export { blocksStand, type BlocksStand } from "./stand/stand.ts";
