import type { GateApi } from "@switchboard/gate";
import type { Registry } from "./registry.ts";

export interface Env {
  /** gate: пропуск прямого запроса */
  GATE: GateApi;
  CF_ACCOUNT_ID: string;
  /** пара S3 токена R2 бакета точек: ею подписаны ссылки машине на блоки */
  R2_KEY_ID: string;
  R2_KEY_SECRET: string;
  /** бакет блоков точек */
  POINTS_BUCKET: string;
  /** привязка к бакету точек — только чтобы проверять и удалять блоки */
  BUCKET: R2Bucket;
  /** объект реестра, один на флот */
  REGISTRY: DurableObjectNamespace<Registry>;
}
