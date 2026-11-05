// Модули страницы: кто владеет экраном, командой, кадром и меткой; ловушка — бросил, значит выключен до перезапуска приложения.
import { nameOf } from "./gate.ts";
import type { App, AppModule, AppPart, Command, Manifest, Screen } from "./types.ts";

export type Mod = { m: Manifest; mod: AppModule; app: App; failed: string | null };
export type ScreenEntry = { owner: Mod; def: Screen };
export type CommandEntry = { owner: Mod; def: Command };
export type Modules = ReturnType<typeof createModules>;

export function createModules(changed: () => void) {
  const list: Mod[] = [];
  const screens = new Map<string, ScreenEntry>();
  const commands = new Map<string, CommandEntry>();
  const frameOwners = new Map<string, Mod>();
  const markOwners = new Map<string, Mod>();

  function fail(x: Mod, where: string, e: unknown) {
    if (x.failed) return;
    x.failed = `Модуль ${x.m.name} упал на ${where}: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`;
    console.error(x.failed, e);
    changed();
  }

  /** Вызов модуля под ловушкой; выключенного не зовёт. */
  function call<R>(x: Mod, where: string, fn: () => R): R | undefined {
    if (x.failed) return undefined;
    try {
      return fn();
    } catch (e) {
      fail(x, where, e);
      return undefined;
    }
  }

  /** То же для вызова, который возвращает обещание. */
  async function settle(x: Mod, where: string, fn: () => unknown) {
    if (x.failed) return;
    try {
      await fn();
    } catch (e) {
      fail(x, where, e);
    }
  }

  const usesRef = (x: Mod, name: string) => Object.keys(x.m.uses).find((ref) => nameOf(ref) === name);

  return {
    list,
    screens,
    commands,
    fail,
    call,
    usesRef,
    frameOwner: (type: string) => frameOwners.get(type),
    markOwner: (name: string) => markOwners.get(name),
    /** Модуль этого App. */
    ofApp: (app: App) => list.find((x) => x.app === app),
    /** Определить модули: сначала App, затем функция модуля. Бросила — модуль выключен, на его экранах причина. */
    define(parts: AppPart[], appFor: (x: Mod) => App) {
      for (const p of parts) {
        const x: Mod = { m: p.manifest, mod: {}, app: null as never, failed: null };
        x.app = appFor(x);
        list.push(x);
        x.mod = call(x, "старте", () => p.module(x.app)) ?? { screens: Object.fromEntries(Object.keys(p.manifest.provides).map((n) => [n, {}])) };
      }
    },
    /** Занести владельцев: набор прошёл гейт. */
    register() {
      for (const x of list) {
        for (const t of Object.keys(x.mod.frames ?? {})) frameOwners.set(t, x);
        for (const n of Object.keys(x.mod.marks ?? {})) markOwners.set(n, x);
        for (const [n, def] of Object.entries(x.mod.screens ?? {})) screens.set(n, { owner: x, def });
        for (const [n, def] of Object.entries(x.mod.commands ?? {})) commands.set(n, { owner: x, def });
      }
    },
    /** Экран или команда доступны модулю: свои, из uses или вставленные в его место. */
    mayOpen(x: Mod, name: string): boolean {
      if (x.mod.screens?.[name] !== undefined || x.mod.commands?.[name] !== undefined || usesRef(x, name)) return true;
      const place = screens.get(name)?.def.place ?? commands.get(name)?.def.place;
      return place !== undefined && x.m.provides[place] !== undefined;
    },
    async startAll() {
      for (const x of list) if (x.mod.start) await settle(x, "старте", () => x.mod.start!());
    },
    /** Страница вернулась на экран. */
    async showAll() {
      for (const x of list) if (x.mod.on?.show) await settle(x, "возвращении на экран", () => x.mod.on!.show!());
    },
    /** Уход с экрана: в обратном порядке. */
    async stopAll() {
      for (const x of [...list].reverse()) if (x.mod.stop) await settle(x, "остановке", () => x.mod.stop!());
    },
  };
}
