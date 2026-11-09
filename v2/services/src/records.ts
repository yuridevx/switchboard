// Записи модуля: объект с SQLite, отдельный на модуль и флот (у архива — на машину). Исполняет только короткие запросы;
// обработчики модулей и сеть живут в Worker'е. Схему модуля применяет при первом обращении.
import { DurableObject } from "cloudflare:workers";
import { Refusal } from "@sb/protocol";
import type { Env } from "./env.ts";

type Value = string | number | null;
export type Op = [sql: string, ...params: Value[]];
type Row = Record<string, Value>;

export class Records extends DurableObject<Env> {
  /** схемы, уже применённые этим экземпляром */
  private applied = new Set<string>();

  /** Запросы одной пачкой, всё или ничего. Ответ — строки каждого запроса. */
  run(schema: string[], ops: Op[]): Row[][] {
    const key = schema.join(";");
    if (!this.applied.has(key)) {
      for (const s of schema) this.ctx.storage.sql.exec(s);
      this.applied.add(key);
    }
    const sql = this.ctx.storage.sql;
    return this.ctx.storage.transactionSync(() => ops.map(([text, ...params]) => sql.exec(text, ...params).toArray() as Row[]));
  }
}

/** Записи модуля глазами обработчика. */
export interface Db {
  all<T = Row>(sql: string, ...params: Value[]): Promise<T[]>;
  first<T = Row>(sql: string, ...params: Value[]): Promise<T | null>;
  run(sql: string, ...params: Value[]): Promise<void>;
  batch(ops: Op[]): Promise<Row[][]>;
}

/** Объект записей модуля во флоте; scope — машина у архива. Переполнение и сбой хранилища — отказ словом. */
export function records(env: Env, fleet: string, module: string, schema: string[], scope?: string): Db {
  const name = scope ? `${fleet}/${module}/${scope}` : `${fleet}/${module}`;
  const stub = env.RECORDS.get(env.RECORDS.idFromName(name));
  const batch = async (ops: Op[]): Promise<Row[][]> => {
    try {
      return (await stub.run(schema, ops)) as Row[][];
    } catch (e) {
      throw new Refusal("records_failed", `записи ${name}: ${e instanceof Error ? e.message : e}`);
    }
  };
  return {
    batch,
    all: async <T>(sql: string, ...params: Value[]) => (await batch([[sql, ...params]]))[0] as T[],
    first: async <T>(sql: string, ...params: Value[]) => ((await batch([[sql, ...params]]))[0]![0] ?? null) as T | null,
    run: async (sql, ...params) => void (await batch([[sql, ...params]])),
  };
}
