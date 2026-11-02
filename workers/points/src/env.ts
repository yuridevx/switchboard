import type { GateApi } from "@switchboard/gate";

export interface Env {
  /** записи модуля — база D1 модуля во флоте */
  DB: D1Database;
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
  /** журнал: строки session.copied, moved, rolled_back, deleted — по своей привязке */
  LEDGER: { frame(f: import("@switchboard/protocol").Frame): Promise<unknown> };
}
