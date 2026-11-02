import type { GateApi } from "@switchboard/gate";

export interface Env {
  /** записи модуля — база D1 модуля во флоте */
  DB: D1Database;
  /** relay: план keeper'у — в объект его машины */
  RELAY: { deliver(f: import("@switchboard/protocol").Frame): Promise<number> };
  /** gate: пропуск прямого запроса и машины флота */
  GATE: GateApi;
  /** журнал: строки part.deployed — по своей привязке */
  LEDGER: { frame(f: import("@switchboard/protocol").Frame): Promise<unknown> };
  /** токен API Cloudflare: список версий Worker'ов и выкладка */
  CLOUDFLARE_API_TOKEN: string;
  /** ключ R2 бакета выпусков: им подписаны ссылки на чтение и запись архивов */
  R2_LINK_KEY_ID: string;
  R2_LINK_SECRET: string;
  CF_ACCOUNT_ID: string;
  /** имя флота: по нему — имя Worker'а из module.json каталога (workers.<флот>) */
  FLEET: string;
  /** привязка к бакету выпусков: список и хэши архивов */
  BUCKET: R2Bucket;
}
