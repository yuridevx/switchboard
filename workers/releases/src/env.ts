import type { Frame } from "@switchboard/protocol";
import type { Releases } from "./releases.ts";

/** Вход Radio relay (контракт frame@relay): свой кадр или reply; ответ — слово отказа или ничего. */
export type Radio = { frame(f: Frame): Promise<string | undefined> };

/** Ответ участника на hello(): контракт. */
export type ParticipantHello = { contract: Record<string, number> };

export interface Env {
  /** токен API Cloudflare: список версий Worker'ов и выкладка */
  CLOUDFLARE_API_TOKEN: string;
  /** ключ R2 бакета выпусков: им подписаны ссылки на чтение и запись архивов */
  R2_LINK_KEY_ID: string;
  R2_LINK_SECRET: string;
  CF_ACCOUNT_ID: string;
  RELEASES_BUCKET: string;
  /** части Cloudflare: имя части → имя Worker'а */
  CLOUD: Record<string, string>;
  /** части машины из сборки — их выкладывает deploy * */
  BUILD: string[];
  /** привязка к бакету выпусков: список и хэши архивов */
  BUCKET: R2Bucket;
  /** своя привязка к relay: вход Radio, props { name: "releases" } */
  RELAY: Radio;
  /** объект выпусков, один на флот */
  RELEASES: DurableObjectNamespace<Releases>;
}
