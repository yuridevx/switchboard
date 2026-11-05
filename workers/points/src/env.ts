import type { GateApi } from "@switchboard/gate";
import type { Frame } from "@switchboard/protocol";

export interface Env {
  /** записи модуля — база D1 модуля во флоте */
  DB: D1Database;
  /** блоки точек; байты кладёт и берёт машина по ссылкам */
  BUCKET: R2Bucket;
  /** gate: пропуск прямого запроса */
  GATE: GateApi;
  /** журнал флота: строки о сессиях */
  LEDGER: { frame(f: Frame): Promise<unknown> };
  /** пара S3 токена R2: ею подписаны ссылки на блоки */
  R2_KEY_ID: string;
  R2_KEY_SECRET: string;
  CF_ACCOUNT_ID: string;
  POINTS_BUCKET: string;
}
