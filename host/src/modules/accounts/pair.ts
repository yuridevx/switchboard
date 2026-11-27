// Пара «провайдер · модель» глазами процесса: имя, которое получает Claude Code, окружение запуска и срок кэша ответа.
// Правила здесь — единственное место, где живут суффикс «[1m]» и предел окна.
import { CLAUDE, type Protocol } from "@sb/protocol";

/** Что машина знает о паре документа: из каталога провайдера и из его ключа. Пишется при смене и при запуске процесса. */
export type Pair = {
  key: string; model: string; protocol: Protocol;
  /** окно контекста модели по каталогу, токены */
  window?: number;
  /** адрес API провайдера; у аккаунтов Claude его нет */
  base?: string;
  /** окружение и настройки сессии на этом ключе */
  env?: Record<string, string>;
  settings?: Record<string, unknown>;
  /** срок кэша разговора у провайдера, минуты: поле ключа */
  cache?: number;
};

/** Суффикс Claude Code у имени модели: с ним процесс считает окно контекста в миллион токенов. */
const WIDE = "[1m]";
/** Окно, которое Claude Code даёт имени без суффикса и с ним. */
const NAME_WINDOW = 200_000, WIDE_WINDOW = 1_000_000;
/** Сжатие при простое: за столько до конца срока кэша; разговор от стольких токенов. */
export const COMPACT_BEFORE_MS = 6 * 60_000, COMPACT_FROM = 200_000;
/** Срок кэша Claude: его называет сам ответ — запись на час или на пять минут. */
const HOUR_MS = 3_600_000, SHORT_MS = 300_000;

/** Имя модели для процесса: окно больше обычного — с «[1m]»; каталог окна не назвал — имя как есть. */
export function procModel(p: Pick<Pair, "model" | "window">): string {
  return (p.window ?? 0) > NAME_WINDOW && !p.model.endsWith(WIDE) ? p.model + WIDE : p.model;
}

/** Имя модели для провайдера. Суффикс «[1m]» в имени каталога — знак широкого окна для Claude Code: сам Claude Code в запросе его не шлёт,
 *  и провайдер знает модель без него (факт живой проверки: OpenRouter на имя с суффиксом отвечает 404). */
export const wireModel = (model: string): string => (model.endsWith(WIDE) ? model.slice(0, -WIDE.length) : model);

/** Точный предел окна при запуске: нужен, когда окно каталога не совпадает ни с одним из двух окон по имени. */
export function capOf(p: Pick<Pair, "window">): number | undefined {
  const w = p.window;
  return w === undefined || w === NAME_WINDOW || w >= WIDE_WINDOW ? undefined : w;
}

/** Окружение запуска, которое зависит от пары: предел окна и окружение ключа. Процесс с другим окружением перезапускают после хода. */
export function launchEnv(p: Pair): Record<string, string> {
  const cap = capOf(p);
  return { ...p.env, ...(cap ? { CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(cap) } : {}) };
}

/** Подпись окружения запуска: по ней видно, поднят ли процесс с тем, что нужно паре. */
export const launchSig = (p: Pair): string => JSON.stringify([Object.entries(launchEnv(p)).sort(), p.settings ?? {}]);

type Usage = { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number; cache_creation?: { ephemeral_1h_input_tokens?: number; ephemeral_5m_input_tokens?: number } };
/** Запись кэша разговора: о модели, которая ответила. ttl — срок, мс: нет — провайдер его не называет и на ключе он не задан. */
export type Cache = { at: number; size: number; read: number; ttl?: number; model: string };

/** Кэш после ответа модели: размер разговора, прочитанное из кэша и срок. Claude срок называет сам; у остальных он — поле ключа. */
export function cacheOf(u: Usage, model: string, pair: Pair, was: Cache | undefined, at: number): Cache {
  const read = u.cache_read_input_tokens ?? 0;
  const size = (u.input_tokens ?? 0) + read + (u.cache_creation_input_tokens ?? 0);
  const made = u.cache_creation;
  // ответ без записи в кэш срока не называет: у той же модели он прежний
  const said = (made?.ephemeral_1h_input_tokens ?? 0) > 0 ? HOUR_MS : (made?.ephemeral_5m_input_tokens ?? 0) > 0 ? SHORT_MS : was?.model === model ? was.ttl : undefined;
  const ttl = pair.key === CLAUDE ? (said ?? SHORT_MS) : pair.cache ? pair.cache * 60_000 : undefined;
  return { at, size, read, ...(ttl ? { ttl } : {}), model };
}

/** Разговор большой: его стоит сжать — при простое и на границе тикетов. Порог один. */
export const big = (c: Cache): boolean => c.size >= COMPACT_FROM;

/** До какого времени кэш тёплый и когда сжать разговор при простое: оба часа считаются здесь. */
export function hours(c: Cache): { until?: number; compact?: number } {
  if (!c.ttl) return {};
  const until = c.at + c.ttl;
  return { until, ...(big(c) && c.ttl > COMPACT_BEFORE_MS ? { compact: until - COMPACT_BEFORE_MS } : {}) };
}
