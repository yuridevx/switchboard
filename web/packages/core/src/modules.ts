// Реестр модулей: кто чем владеет, ловушка каждого вызова модуля, разделы страницы в порядке оболочки.
import type { Page } from "./page.ts";
import type { App, AppModule, AppPart, Command, Manifest, Params, Screen } from "./types.ts";

export type Mod = { name: string; manifest: Manifest; def: AppModule; app: App };
export type Owned<T> = { name: string; def: T; mod: Mod };

/** Раздел страницы. */
export type Section = Owned<Screen> & { label: string };

/** Экран в месте top ядра в адрес и в поиск не идёт. */
const TOP = "top";

export type Modules = ReturnType<typeof createModules>;

export function createModules(page: Page) {
  const list: Mod[] = [];
  const screens = new Map<string, Owned<Screen>>();
  const commands = new Map<string, Owned<Command>>();
  const marks = new Map<string, Owned<(...a: string[]) => unknown>>();
  const frames = new Map<string, Owned<NonNullable<AppModule["frames"]>[string]>>();
  const sections: Section[] = [];

  const fail = (mod: Mod, text: string) => {
    page.failed[mod.name] ??= text;
    console.error(`switchboard: ${text}`);
    page.changed();
  };
  /** Нарушение контракта вызывающим: выключен он. */
  const refuse = (mod: Mod, text: string) => fail(mod, `Модуль ${mod.name}: ${text}`);
  const crash = (mod: Mod, where: string, e: unknown) => fail(mod, `Модуль ${mod.name} упал на ${where}: ${e}`);

  /** Вызов модуля: бросил или отказал — выключен до перезапуска; выключенный не зовётся. */
  function call<T>(mod: Mod, where: string, fn: () => T): T | undefined {
    if (page.failed[mod.name] !== undefined) return undefined;
    try {
      const r = fn();
      return (r instanceof Promise ? r.catch((e) => crash(mod, where, e)) : r) as T;
    } catch (e) {
      crash(mod, where, e);
      return undefined;
    }
  }

  const add = <T>(to: Map<string, Owned<T>>, items: Record<string, T> | undefined, mod: Mod) => {
    for (const [name, def] of Object.entries(items ?? {})) to.set(name, { name, def, mod });
  };

  function define(parts: AppPart[], appOf: (mod: Mod) => App) {
    for (const { manifest, module } of parts) {
      const mod: Mod = { name: manifest.name, manifest, def: {}, app: null as never };
      mod.app = appOf(mod);
      list.push(mod);
      const def = call(mod, "старте", () => module(mod.app));
      if (def) mod.def = def;
      else for (const name of Object.keys(manifest.provides)) screens.set(name, { name, def: {}, mod });
      add(screens, mod.def.screens, mod);
      add(commands, mod.def.commands, mod);
      add(marks, mod.def.marks, mod);
      add(frames, mod.def.frames, mod);
    }
  }

  /** Разделы: порядок оболочки, остальные следом по списку модулей. */
  function order() {
    const all = [...screens.values()].filter((s) => s.def.nav && !s.def.place);
    const rank = (s: Owned<Screen>) => {
      const i = page.o.sections?.indexOf(s.name) ?? -1;
      return i < 0 ? Infinity : i;
    };
    const sorted = all.map((s, i) => ({ s, i })).sort((a, b) => rank(a.s) - rank(b.s) || a.i - b.i);
    sections.push(...sorted.map(({ s }) => ({ ...s, label: s.def.nav! })));
  }

  /** Имя из uses модуля: версия и владелец. */
  function uses(mod: Mod, name: string) {
    const use = Object.keys(mod.manifest.uses).find((u) => u.slice(0, u.lastIndexOf("@")) === name);
    return use ? { v: mod.manifest.uses[use], owner: use.slice(use.lastIndexOf("@") + 1) } : null;
  }

  /** Видна ли вставка с этими параметрами. */
  const shown = <T extends { show?(p: Params): boolean }>(item: Owned<T>, params: Params) => !item.def.show || call(item.mod, `показе ${item.name}`, () => item.def.show!(params)) === true;

  /** Вставки места: экраны и команды. */
  const inPlace = (place: string, params: Params) => ([...screens.values(), ...commands.values()] as Array<Owned<Screen | Command>>).filter((x) => x.def.place === place && shown(x, params));

  /** Может ли модуль взять экран или команду: своё, из uses или вставленное в его место. */
  const reaches = (mod: Mod, item: Owned<Screen | Command> | undefined, name: string) =>
    item?.mod === mod || !!uses(mod, name) || (!!item?.def.place && Object.hasOwn(mod.manifest.provides, item.def.place));

  return {
    list,
    screens,
    commands,
    marks,
    frames,
    sections,
    define,
    order,
    fail,
    refuse,
    crash,
    call,
    uses,
    inPlace,
    reaches,
    /** Модули с их определением: что проверяет гейт. */
    defined: () => list.map((m) => ({ manifest: m.manifest, module: m.def })),
    tops: () => [...screens.values()].filter((s) => s.def.place === TOP && shown(s, {})),
    isTop: (s: Owned<Screen>) => s.def.place === TOP,
    /** Вызов на всех живых модулях по порядку. */
    each(where: string, fn: (d: AppModule) => unknown) {
      for (const m of list) call(m, where, () => fn(m.def));
    },
    /** Значение метки; выключенный владелец — пусто. */
    mark(name: string, args: string[]) {
      const m = marks.get(name);
      return m && call(m.mod, `метке ${name}`, () => m.def(...args));
    },
  };
}
