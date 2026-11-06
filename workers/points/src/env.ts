// Привязки и переменные Worker'а points (config в module.json).
import type { GateApi } from "@switchboard/gate";
import type { Frame } from "@switchboard/protocol";

export interface Env {
  /** реестр: sessions, points, blocks, refs, meta */
  DB: D1Database;
  /** блоки точек: f/<отпечаток> */
  BUCKET: R2Bucket;
  /** пропуск прямого запроса */
  GATE: GateApi;
  /** журнал флота: ledger.add */
  LEDGER: { frame(f: Frame): Promise<Frame[]> };
  /** ключ S3 токена R2 бакета точек: им подписываются ссылки */
  CF_ACCOUNT_ID: string;
  R2_KEY_ID: string;
  R2_KEY_SECRET: string;
  POINTS_BUCKET: string;
}
