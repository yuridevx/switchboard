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
    /** Занести модули выпуска; app — его App. */
    add(parts: AppPart[], appFor: (x: Mod) => App) {
      for (const p of parts) {
        const x: Mod = { m: p.manifest, mod: p.module, app: null as unknown as App, failed: null };
        x.app = appFor(x);
        mods.push(x);
        for (const t of Object.keys(p.module.frames ?? {})) frameOwner.set(t, x);
        for (const [n, def] of Object.entries(p.module.screens ?? {})) screenOwner.set(n, { owner: x, def });
        for (const n of Object.keys(p.module.marks ?? {})) markOwner.set(n, x);
      }
    },
    fail,
    call,
    callAsync,
    usesRef,
    frameOwner: (type: string) => frameOwner.get(type),
    markOwner: (name: string) => markOwner.get(name),
    lookup: (screen: string) => screenOwner.get(screen),
    /** Может ли модуль открыть экран: свой, из uses или вставленный в его место. */
    mayOpen(x: Mod, screen: string): boolean {
      const at = screenOwner.get(screen)?.def.place;
      return x.mod.screens?.[screen] !== undefined || (at !== undefined && x.m.provides[at] !== undefined) || !!usesRef(x, screen);
    },
    /** Запустить start модулей по порядку. */
    async startAll() {
      for (const x of mods) if (x.mod.start) await callAsync(x, "старте", () => x.mod.start!(x.app));
    },
    /** Остановить модули в обратном порядке. */
    async stopAll() {
      for (const x of [...mods].reverse()) if (x.mod.stop) await callAsync(x, "остановке", () => x.mod.stop!());
    },
  };
}
