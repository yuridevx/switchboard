// Ловушка ошибок модуля. Каждый вызов модуля идёт через неё: ошибка не идёт дальше, модуль выключается там, откуда его звали.
// Отказ словом — не ошибка: его ловит вызывающий. Самопочинки нет: чинит агент новым выпуском.
import { AsyncLocalStorage } from "node:async_hooks";
import type { LogRecord, Manifest, Module } from "../contract.ts";
import type { Clock } from "./clock.ts";
import { isRefusal } from "./refusal.ts";

export const MODULE_ERROR = "module_error";
/** Предел start(), session() и opening(): вдвое выше самого долгого старта Host (host_start → ready до 5,9 с). */
export const START_MS = 12_000;

/** Метка исключения, которое уже выключило модуль: второй раз не выключает. */
const ALREADY = Symbol("handled");

/** Загруженный модуль. */
export class Mod {
  readonly name: string;
  readonly manifest: Manifest;
  readonly module: Module;
  /** причина выключения на всей машине */
  down: string | null = null;
  constructor(m: Manifest, mod: Module) {
    this.name = m.name;
    this.manifest = m;
    this.module = mod ?? {};
  }
}

/** Где модуль выключается: сессия. Сессии нет — на всей машине. */
export type Scope = {
  readonly callsign: string;
  readonly failed: Map<string, string>;
  push(): void;
};

/** Нарушение договора выключило модуль: отказ не роняет Host, даже если модуль его не ждёт. */
export function handled<T>(p: Promise<T>): Promise<T> {
  p.catch(() => {});
  return p;
}

export class Trap {
  mods: Mod[] = [];
  byName = new Map<string, Mod>();
  private readonly als = new AsyncLocalStorage<{ mod: string; scope: Scope | null }>();
  private readonly log: (rec: LogRecord) => void;
  private readonly clock: Clock;
  /** выключили на машине: записи всех сессий изменились */
  private readonly pushAll: () => void;

  constructor(o: { log: (rec: LogRecord) => void; clock: Clock; pushAll: () => void }) {
    this.log = o.log;
    this.clock = o.clock;
    this.pushAll = o.pushAll;
  }

  load(mods: Mod[]): void {
    this.mods = mods;
    this.byName = new Map(mods.map((m) => [m.name, m]));
  }

  isDown(m: Mod, scope: Scope | null): boolean {
    return !!m.down || (!!scope && scope.failed.has(m.name));
  }

  /** Вызов модуля. Ошибка — модуль выключен, ответ onFail; отказ словом идёт вызывающему; модуль уже выключен — сразу onFail. */
  call<T>(m: Mod, where: string, scope: Scope | null, fn: (x: Module) => T | Promise<T>, onFail: (e: unknown) => T): T | Promise<T> {
    if (this.isDown(m, scope)) return onFail(new Error(MODULE_ERROR));
    const failed = (e: unknown): T => {
      if (isRefusal(e)) throw e;
      this.disable(m, scope, where, e);
      return onFail(e);
    };
    try {
      const r = this.als.run({ mod: m.name, scope }, () => fn(m.module));
      return isPromise<T>(r) ? r.then(undefined, failed) : r;
    } catch (e) {
      return failed(e);
    }
  }

  /** Выключить модуль в сессии или на машине: failed в roster, строка stop в журнале. */
  disable(m: Mod, scope: Scope | null, where: string, e: unknown): void {
    if (e && typeof e === "object" && (e as Record<symbol, unknown>)[ALREADY]) return;
    const message = e instanceof Error ? e.message : String(e);
    const short = `${message} · ${where}`;
    if (scope) {
      if (scope.failed.has(m.name)) return;
      scope.failed.set(m.name, short);
    } else {
      if (m.down) return;
      m.down = short;
    }
    const stack = e instanceof Error && e.stack ? e.stack : message;
    this.log({
      kind: "stop",
      ev: "module_failed",
      word: MODULE_ERROR,
      module: m.name,
      ...(scope ? { callsign: scope.callsign } : {}),
      why: `${m.name}: ${where} — ${stack}; модуль выключен ${scope ? "в сессии" : "на машине"}`,
    });
    if (scope) scope.push();
    else this.pushAll();
  }

  /** Нарушение договора: модуль выключен там, откуда звал, и получает исключение. */
  violation(m: Mod, scope: Scope | null, reason: string): never {
    const e = new Error(reason);
    this.disable(m, scope, "договор", e);
    (e as unknown as Record<symbol, boolean>)[ALREADY] = true;
    throw e;
  }

  /** Сессия, из вызова которой модуль m зовёт ядро сейчас. */
  callerOf(m: Mod): Scope | null {
    const c = this.als.getStore();
    return c && c.mod === m.name ? c.scope : null;
  }

  /**
   * Ошибка вне вызова ядра — в работе, которую модуль начал сам (таймер, цепочка, событие): контекст вызова, где её
   * начали, наследуется, и модуль выключается там же. Модуль не определился — false: решает процесс (выход 1).
   */
  stray(e: unknown): boolean {
    const c = this.als.getStore();
    const m = c && this.byName.get(c.mod);
    if (!m) return false;
    this.disable(m, c.scope, "работа вне вызова ядра", e);
    return true;
  }

  /** Значение или исключение со словами why за предел START_MS по часам ядра: ловушка выключает модуль. */
  within<T>(r: T | Promise<T>, why: string): T | Promise<T> {
    if (!isPromise<T>(r)) return r;
    let t: unknown;
    const late = new Promise<never>((_ok, no) => (t = this.clock.setTimeout(() => no(new Error(why)), START_MS)));
    return Promise.race([r, late]).finally(() => this.clock.clearTimeout(t));
  }
}

function isPromise<T>(r: T | Promise<T>): r is Promise<T> {
  return !!r && typeof (r as Promise<T>).then === "function";
}
