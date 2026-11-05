// Ловушка: каждый вызов модуля идёт через неё. Бросил — модуль выключен там, где его звали: в сессии или на машине.
// Контекст вызова наследуют таймеры и цепочки модуля, поэтому и работа вне вызова находит, чья она.
import { AsyncLocalStorage } from "node:async_hooks";
import type { Manifest, Module } from "../contract.ts";
import { nameOf, ownerOf } from "@switchboard/manifest-gate";
import { limit, type Clock } from "./clock.ts";
import type { Journal } from "./journal.ts";

/** Предел вызова модуля на старте: вдвое выше самого долгого старта Host (5,9 с). */
const CALL_LIMIT_MS = 12_000;

/** Сессия глазами ловушки: где записать, что модуль выключен. */
export interface Place {
  readonly callsign: string;
  readonly failed: Record<string, string>;
  refresh(): void;
}

export class Mod {
  readonly name: string;
  readonly manifest: Manifest;
  readonly module: Module;
  /** выключен на машине: причина и место */
  down?: string;

  constructor(manifest: Manifest, module: Module) {
    this.name = manifest.name;
    this.manifest = manifest;
    this.module = module;
  }

  isOff(place?: Place): boolean {
    return this.down !== undefined || place?.failed[this.name] !== undefined;
  }

  /** Имя из своих provides или uses: версия и владелец. Одно правило для запроса, кадра и поля. */
  ref(name: string): { owner: string; v: number } | null {
    if (Object.hasOwn(this.manifest.provides, name)) return { owner: this.name, v: this.manifest.provides[name] };
    const use = Object.keys(this.manifest.uses).find((u) => nameOf(u) === name);
    return use ? { owner: ownerOf(use), v: this.manifest.uses[use] } : null;
  }
}

export class Trap {
  private readonly scope = new AsyncLocalStorage<{ mod: Mod; place?: Place }>();
  /** ошибки, о которых журнал уже знает: нарушение договора бросается модулю и может вернуться как ничья */
  private readonly known = new WeakSet<object>();
  private readonly journal: Journal;
  private readonly clock: Clock;
  private readonly everywhere: () => Iterable<Place>;

  constructor(journal: Journal, clock: Clock, everywhere: () => Iterable<Place>) {
    this.journal = journal;
    this.clock = clock;
    this.everywhere = everywhere;
  }

  /** Выключить модуль; уже выключен — ничего. */
  fail(mod: Mod, place: Place | undefined, where: string, e: unknown): void {
    if (mod.isOff(place)) return;
    const note = `${e instanceof Error ? e.message : String(e)} · ${where}`;
    const text = e instanceof Error ? (e.stack ?? String(e)) : String(e);
    this.journal.write("core", { kind: "stop", ev: "module_failed", word: "module_error", module: mod.name, ...(place ? { callsign: place.callsign } : {}), why: `${mod.name}: ${where} — ${text}; модуль выключен ${place ? "в сессии" : "на машине"}` });
    if (place) {
      place.failed[mod.name] = note;
      place.refresh();
    } else {
      mod.down = note;
      for (const p of this.everywhere()) p.refresh();
    }
  }

  /** Вызов модуля; бросил — выключен, ответ fallback. */
  call<T>(mod: Mod, place: Place | undefined, where: string, fn: () => T, fallback: T): T {
    try {
      return this.scope.run({ mod, place }, fn);
    } catch (e) {
      this.fail(mod, place, where, e);
      return fallback;
    }
  }

  /** То же для вызова, который может быть асинхронным. */
  async wait<T>(mod: Mod, place: Place | undefined, where: string, fn: () => T | Promise<T>, fallback: T): Promise<T> {
    try {
      return await this.scope.run({ mod, place }, fn);
    } catch (e) {
      this.fail(mod, place, where, e);
      return fallback;
    }
  }

  /** То же с пределом: start, session, opening. */
  limited<T>(mod: Mod, place: Place | undefined, where: string, fn: () => T | Promise<T>, fallback: T): Promise<T> {
    return limit(this.clock, this.wait(mod, place, where, fn, fallback), CALL_LIMIT_MS, () => {
      this.fail(mod, place, where, `${where}() не вернулся за ${CALL_LIMIT_MS / 1000} с`);
      return fallback;
    });
  }

  /** Вызов без контекста модуля: то, что начато здесь, — дело ядра. */
  outside<T>(fn: () => T): T {
    return this.scope.exit(fn);
  }

  /** Модуль нарушил договор: выключен там, где его застали; ошибку бросает зовущий. */
  violation(mod: Mod, place: Place | undefined, what: string): Error {
    const e = new Error(what);
    const now = this.scope.getStore();
    this.fail(mod, place ?? (now?.mod === mod ? now.place : undefined), "договор", e);
    this.known.add(e);
    return e;
  }

  /** Ошибка вне вызова ядра: true — она модуля и он выключен, false — ничья, решает процесс. */
  stray(e: unknown): boolean {
    if (typeof e === "object" && e !== null && this.known.has(e)) return true;
    const now = this.scope.getStore();
    if (!now) return false;
    this.fail(now.mod, now.place, "работа вне вызова ядра", e);
    return true;
  }
}

/** Отказ, который не поднимется как необработанный, если модуль не ждёт ответа. */
export function rejected<T>(e: Error): Promise<T> {
  const p = Promise.reject<T>(e);
  p.catch(() => {});
  return p;
}
