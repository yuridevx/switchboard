// Реестр модулей: кто владеет экраном, кадром и меткой; ловушка ошибок модуля — бросил, значит выключен до перезапуска приложения.
import { nameOf } from "./gate.ts";
import type { Mod, ScreenEntry } from "./mod.ts";
import type { App, AppPart } from "./types.ts";

export type Registry = ReturnType<typeof createRegistry>;

export function createRegistry(changed: () => void) {
  const mods: Mod[] = [];
  const frameOwner = new Map<string, Mod>();
  const screenOwner = new Map<string, ScreenEntry>();
  const markOwner = new Map<string, Mod>();

  function fail(x: Mod, where: string, e: unknown) {
    if (x.failed) return;
    x.failed = `Модуль ${x.m.name} упал на ${where}: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`;
    console.error(x.failed, e);
    changed();
  }

  function call<R>(x: Mod, where: string, fn: () => R): R | undefined {
    if (x.failed) return undefined;
    try {
      return fn();
    } catch (e) {
      fail(x, where, e);
      return undefined;
    }
  }

  async function callAsync(x: Mod, where: string, fn: () => unknown) {
    if (x.failed) return;
    try {
      await fn();
    } catch (e) {
      fail(x, where, e);
    }
  }

  const usesRef = (x: Mod, n: string): string | undefined => Object.keys(x.m.uses).find((r) => nameOf(r) === n);

  return {
    mods,
    screens: screenOwner,
    /** Определения модулей выпуска: сначала App, затем функция модуля. Бросила — модуль выключен, на его экранах — причина. */
    define(parts: AppPart[], appFor: (x: Mod) => App) {
      for (const p of parts) {
        const x: Mod = { m: p.manifest, mod: {}, app: null as unknown as App, failed: null };
        x.app = appFor(x);
        mods.push(x);
        x.mod = call(x, "старте", () => p.module(x.app)) ?? { screens: Object.fromEntries(Object.keys(p.manifest.provides).map((n) => [n, {}])) };
      }
    },
    /** Занести владельцев: набор прошёл гейт. */
    add() {
      for (const x of mods) {
        for (const t of Object.keys(x.mod.frames ?? {})) frameOwner.set(t, x);
        for (const [n, def] of Object.entries(x.mod.screens ?? {})) screenOwner.set(n, { owner: x, def });
        for (const n of Object.keys(x.mod.marks ?? {})) markOwner.set(n, x);
      }
    },
    fail,
    call,
    callAsync,
    usesRef,
    frameOwner: (type: string) => frameOwner.get(type),
    markOwner: (name: string) => markOwner.get(name),
    lookup: (screen: string) => screenOwner.get(screen),
    /** Модуль этого App. */
    modOf: (app: App) => mods.find((x) => x.app === app),
    /** Может ли модуль открыть экран: свой, из uses или вставленный в его место. */
    mayOpen(x: Mod, screen: string): boolean {
      const at = screenOwner.get(screen)?.def.place;
      return x.mod.screens?.[screen] !== undefined || (at !== undefined && x.m.provides[at] !== undefined) || !!usesRef(x, screen);
    },
    /** Запустить start модулей по порядку. */
    async startAll() {
      for (const x of mods) if (x.mod.start) await callAsync(x, "старте", () => x.mod.start!());
    },
    /** Страница вернулась на экран: on.show модулей по порядку. */
    async showAll() {
      for (const x of mods) if (x.mod.on?.show) await callAsync(x, "возвращении на экран", () => x.mod.on!.show!());
    },
    /** Остановить модули в обратном порядке. */
    async stopAll() {
      for (const x of [...mods].reverse()) if (x.mod.stop) await callAsync(x, "остановке", () => x.mod.stop!());
    },
  };
}
