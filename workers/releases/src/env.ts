import type { Releases } from "./releases.ts";

export interface Env {
  /** токен API Cloudflare: список версий Worker'ов и выкладка */
  CLOUDFLARE_API_TOKEN: string;
  /** ключ R2 бакета выпусков: им подписаны ссылки на чтение и запись архивов */
  R2_LINK_KEY_ID: string;
  R2_LINK_SECRET: string;
  CF_ACCOUNT_ID: string;
  /** части Cloudflare: имя части → имя Worker'а */
  CLOUD: Record<string, string>;
  /** привязка к бакету выпусков: список и хэши архивов */
  BUCKET: R2Bucket;
  /** объект выпусков, один на флот */
  RELEASES: DurableObjectNamespace<Releases>;
}
