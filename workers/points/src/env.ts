// Привязки и переменные Worker'а points (config в module.json).
import type { GateApi } from "@switchboard/gate";
import type { Frame } from "@switchboard/protocol";

export interface Env {
  /** реестр: sessions, points, blocks, refs, meta */
  DB: D1Database;
  /** хранилище блоков — реализация контракта blocks (blocks-r2 или blocks-ch); какая выложена, points не знает */
  STORE: { frame(f: Frame): Promise<Frame[]> };
  /** пропуск прямого запроса */
  GATE: GateApi;
  /** журнал флота: ledger.add */
  LEDGER: { frame(f: Frame): Promise<Frame[]> };
}
