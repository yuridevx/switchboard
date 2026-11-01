import type { Frame } from "@switchboard/protocol";
import type { Registry } from "./registry.ts";

/** Вход Radio relay (контракт frame@relay): свой кадр или reply; ответ — слово отказа или ничего. */
export type Radio = { frame(f: Frame): Promise<string | undefined> };

/** Ответ участника на hello(): контракт и, если нужен roster, uses. */
export type ParticipantHello = { contract: Record<string, number>; uses?: Record<string, number> };

export interface Env {
  /** токен API Cloudflare: выдаёт временные ключи R2 */
  R2_TOKEN: string;
  CF_ACCOUNT_ID: string;
  /** Access Key ID родительского ключа R2; временный ключ не шире его */
  R2_PARENT_KEY_ID: string;
  /** бакет блоков точек */
  POINTS_BUCKET: string;
  /** привязка к бакету точек — только чтобы проверять и удалять блоки */
  BUCKET: R2Bucket;
  /** своя привязка к relay: вход Radio, props { name: "points" } */
  RELAY: Radio;
  /** объект реестра, один на флот */
  REGISTRY: DurableObjectNamespace<Registry>;
}
