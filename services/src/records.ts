// Записи модуля: объект с SQLite, отдельный на модуль и флот (у архива — на машину). Исполняет только короткие запросы;
// обработчики модулей и сеть живут в Worker'е. Схему модуля применяет при первом обращении.
// У объекта один будильник: модуль ставит его на свой ближайший срок, срок пришёл — объект зовёт обработчик модуля.
import { DurableObject } from "cloudflare:workers";
import { Refusal } from "@sb/protocol";
import type { Env } from "./env.ts";

type Value = string | number | null;
export type Op = [sql: string, ...params: Value[]];
type Row = Record<string, Value>;

/** Записи модуля глазами обработчика. */
export interface Db {
  all<T = Row>(sql: string, ...params: Value[]): Promise<T[]>;
  first<T = Row>(sql: string, ...params: Value[]): Promise<T | null>;
  run(sql: string, ...params: Value[]): Promise<void>;
  batch(ops: Op[]): Promise<Row[][]>;
  /** Будильник объекта: at — когда разбудить (мс), null — снять. */
  alarm(at: number | null): Promise<void>;
}

/** Срок будильника пришёл: записи того же объекта — через db(схема), без обращения к себе по сети. */
export type Bell = (env: Env, fleet: string, db: (schema: string[]) => Db, scope?: string) => Promise<void>;
const BELLS = new Map<string, Bell>();
/** Обработчик будильника модуля: записывается хозяином при загрузке; у модуля один обработчик. */
export function onAlarm(module: string, run: Bell): void {
  if (BELLS.has(module)) throw new Error(`будильник модуля ${module}: второй обработчик`);
  BELLS.set(module, run);
}

const dbOf = (batch: (ops: Op[]) => Promise<Row[][]>, alarm: (at: number | null) => Promise<void>): Db => ({
  batch,
  alarm,
  all: async <T>(sql: string, ...params: Value[]) => (await batch([[sql, ...params]]))[0] as T[],
  first: async <T>(sql: string, ...params: Value[]) => ((await batch([[sql, ...params]]))[0]![0] ?? null) as T | null,
  run: async (sql, ...params) => void (await batch([[sql, ...params]])),
});

/** Имя объекта записей: флот, модуль и, если есть, область. */
const nameOf = (fleet: string, module: string, scope?: string) => (scope ? `${fleet}/${module}/${scope}` : `${fleet}/${module}`);

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

  /** Поставить или снять будильник. Имя объекта запоминается: срок придёт без запроса, и обработчику надо знать, чей это объект. */
  async wake(name: string, at: number | null): Promise<void> {
    if (at === null) return this.ctx.storage.deleteAlarm();
    await this.ctx.storage.put("name", name);
    await this.ctx.storage.setAlarm(at);
  }

  /** Срок пришёл: обработчик модуля. Исключение обработчика — повтор будильника средствами Cloudflare. */
  async alarm(): Promise<void> {
    const name = await this.ctx.storage.get<string>("name");
    if (!name) return;
    const [fleet, module, scope] = name.split("/");
    const run = BELLS.get(module!);
    if (!run) throw new Error(`будильник ${name}: у модуля нет обработчика в этой сборке`);
    await run(this.env, fleet!, (schema) => dbOf(async (ops) => this.run(schema, ops), (at) => this.wake(name, at)), scope);
  }
}

/** Объект записей модуля во флоте; scope — машина у архива. Переполнение и сбой хранилища — отказ словом. */
export function records(env: Env, fleet: string, module: string, schema: string[], scope?: string): Db {
  const name = nameOf(fleet, module, scope);
  const stub = env.RECORDS.get(env.RECORDS.idFromName(name));
  const guard = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (e) {
      throw new Refusal("records_failed", `записи ${name}: ${e instanceof Error ? e.message : e}`);
    }
  };
  return dbOf(
    (ops) => guard(async () => (await stub.run(schema, ops)) as Row[][]),
    (at) => guard(async () => void (await stub.wake(name, at))),
  );
}
