// Окружение Worker'а служб и то, что получает обработчик модуля.
import type { PlatformApi } from "@sb/platform";
import type { Logger, Who } from "@sb/protocol";
import type { Records } from "./records.ts";

/** Вход платформы. alive — живые из названных номеров пропусков: пока платформа его не отдала, отозванные не отсеиваются. */
export type Platform = PlatformApi & {
  fetch?(req: Request): Promise<Response>;
  alive?(fleet: string, kids: string[]): Promise<string[]>;
};

/** Записка очереди аналитики: «точка сохранена». */
export type PointNote = { fleet: string; machine: string; sid: string; point: string };

export interface Env {
  PLATFORM: Platform;
  RECORDS: DurableObjectNamespace<Records>;
  FILES: R2Bucket;
  ANALYTICS: Queue<PointNote>;
  ASSETS?: Fetcher;
  FILES_BUCKET: string;
  R2_ACCOUNT_ID?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  /** закрытый ключ VAPID — JWK строкой */
  VAPID_PRIVATE?: string;
  VAPID_SUB?: string;
  TELEGRAM_BOT_TOKEN?: string;
  /** имя бота без @ */
  TELEGRAM_BOT?: string;
  /** ClickHouse в стороне: нет адреса — аналитика выключена */
  CH_URL?: string;
  CH_USER?: string;
  CH_PASSWORD?: string;
}

/** Что видит обработчик: кто пришёл, флот, журнал, платформа, сеть и «после ответа». */
export interface Ctx {
  env: Env;
  fleet: string;
  who: Who;
  trace: string;
  log: Logger;
  platform: Platform;
  /** сеть: в тестах подменяется */
  fetch: typeof fetch;
  /** работа после ответа */
  after(work: Promise<unknown>): void;
  /** адрес, по которому пришёл запрос: для ссылок на себя */
  origin: string;
}

export type Handler = (input: any, ctx: Ctx) => Promise<unknown>;

/** Модуль служб: имя, схема своих записей и обработчики своих имён договора. */
export interface Module {
  name: string;
  handlers: Record<string, Handler>;
}

/** Что можно подменить на входе: платформа и сеть. */
export interface Deps {
  platform?: Platform;
  fetch?: typeof fetch;
}
