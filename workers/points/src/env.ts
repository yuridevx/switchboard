import type { Registry } from "./registry.ts";

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
  /** объект реестра, один на флот */
  REGISTRY: DurableObjectNamespace<Registry>;
}
