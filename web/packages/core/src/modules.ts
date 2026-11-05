// Реестр модулей страницы: записи, ловушка ошибок, владельцы имён и App, который ядро даёт каждому модулю.
import { nameOf, ownerOf } from "@switchboard/manifest-gate";
import { serviceAddress, type Frame, type Reply } from "@switchboard/protocol";
import type { Bus, Core } from "./core.ts";
import type { Store } from "./store.ts";
import type { App, AppModule, AppPart, Command, Manifest, Params, Result, Screen } from "./types.ts";

export type Entry = { name: string; manifest: Manifest; def: AppModule; app: App };

/** Что реестру нужно от страницы. */
export type Host = {
  core: Core;
  bus: Bus;
  store: Store;
  wide: boolean;
  application?: string;
  workers: Record<string, string>;
  /** порядок разделов от оболочки */
  sections?: string[];
  /** запрос во флот; связи нет — отказ */
  ask(f: Frame, read: boolean): Promise<Reply>;
  open(screen: string, params?: Params): void;
  back(): void;
  toast(text: string, tone?: "ok" | "bad"): void;
  deliver(frame: Frame, ctx?: { open: boolean }): void;
  reload(): void;
  /** app.Slot модуля */
  slot(e: Entry, modules: Modules): App["Slot"];
};

export type Modules = ReturnType<typeof createModules>;

const own = <T>(table: Record<string, T> | undefined, name: string): T | undefined => (table && Object.hasOwn(table, name) ? table[name] : undefined);

export function createModules(parts: AppPart[], host: Host) {
  const { core, bus } = host;
  const entries: Entry[] = [];

  const off = (e: Entry) => Object.hasOwn(core.failed, e.name);
  /** Модуль выключен до перезапуска приложения: первая причина остаётся. */
  function fail(e: Entry, where: string, error: unknown) {
    if (off(e)) return;
    const why = `Модуль ${e.name} упал на ${where}: ${String(error)}`;
    console.error(why, error);
    core.failed[e.name] = why;
    bus.changed();
  }
  /** Вызов модуля под ловушкой: бросил или отказал промис — модуль выключен. */
  function trap<T>(e: Entry, where: string, fn: () => T): T | undefined {
    try {
      const r = fn();
      return r instanceof Promise ? (r.catch((error: unknown) => fail(e, where, error)) as T) : r;
    } catch (error) {
      fail(e, where, error);
      return undefined;
    }
  }

  /** Владелец имени в таблице определения: экран, команда, метка, кадр. */
  function ownerIn<T>(table: (d: AppModule) => Record<string, T> | undefined, name: string): [Entry, T] | null {
    for (const e of entries) {
      const item = own(table(e.def), name);
      if (item) return [e, item];
    }
    return null;
  }
  const screenOf = (name: string) => ownerIn((d) => d.screens, name);
  const usesName = (e: Entry, name: string) => Object.keys(e.manifest.uses).some((ref) => nameOf(ref) === name);
  /** Может ли модуль достать имя: своё, из uses или вставленное в его место. */
  const reaches = (e: Entry, name: string, owner: Entry, place?: string) => owner === e || usesName(e, name) || (!!place && Object.hasOwn(e.manifest.provides, place));
  const screenFor = (e: Entry, name: string) => {
    const found = screenOf(name);
    return found && reaches(e, name, found[0], found[1].place) ? found : null;
  };

  async function request<T>(e: Entry, name: string, body: Record<string, unknown> | undefined, read: boolean): Promise<Result<T>> {
    const ref = Object.keys(e.manifest.uses).find((r) => nameOf(r) === name);
    if (!ref) {
      fail(e, `запросе ${name}`, new Error(`${name} нет в uses`));
      return { ok: false, error: "module_error" };
    }
    const owner = ownerOf(ref);
    const to = Object.hasOwn(host.workers, owner) ? { to: serviceAddress(owner) } : {};
    const r = await host.ask({ type: name, v: e.manifest.uses[ref], ...to, ...body }, read);
    if (r.ok) return { ok: true, result: r.result as T };
    const { why } = r as { why?: string };
    return why === undefined ? { ok: false, error: r.error } : { ok: false, error: r.error, why };
  }

  function placed(e: Entry, place: string, params: Params = {}) {
    if (!Object.hasOwn(e.manifest.provides, place)) {
      fail(e, `месте ${place}`, new Error(`места ${place} нет в provides`));
      return [];
    }
    return entries.flatMap((guest) => {
      if (off(guest)) return [];
      const items: Array<[string, Screen | Command]> = [...Object.entries(guest.def.screens ?? {}), ...Object.entries(guest.def.commands ?? {})];
      return items.flatMap(([name, item]) => {
        if (item.place !== place) return [];
        const shown = !item.show || trap(guest, `месте ${name}`, () => item.show!(params)) === true;
        return shown ? [{ name, label: item.label ?? name }] : [];
      });
    });
  }

  const markOf = (owner: Entry, name: string, args: string[] = []) => (off(owner) ? undefined : trap(owner, `метке ${name}`, () => owner.def.marks![name](...args)));

  function appFor(e: Entry): App {
    return {
      get name() {
        return core.key?.split(".")[1] ?? "";
      },
      address: () => core.address,
      application: host.application,
      wide: host.wide,
      request: (name, body) => request(e, name, body, false),
      read: (name, body) => request(e, name, body, true),
      open(screen, params) {
        // имя из uses: владельца может не быть в сборке — адрес меняется, экран — домашний
        if (screenFor(e, screen) || usesName(e, screen)) host.open(screen, params);
        else fail(e, `открытии ${screen}`, new Error(`экрана ${screen} нет в uses`));
      },
      run(command, params = {}) {
        const found = ownerIn((d) => d.commands, command);
        if (!found || !reaches(e, command, found[0], found[1].place)) return fail(e, `команде ${command}`, new Error(`команды ${command} нет в uses`));
        if (!off(found[0])) trap(found[0], `команде ${command}`, () => found[1].run(params));
      },
      placed: (place, params) => placed(e, place, params),
      back: host.back,
      can(machine, name) {
        const m = core.roster?.machines.find((x) => x.machine === machine);
        return m ? Object.hasOwn(m.contract ?? {}, name) : null;
      },
      roster: () => core.roster,
      worker: (name) => own(host.workers, name) ?? null,
      current: () => core.current,
      link: () => core.link,
      mark(name: string, ...args: string[]) {
        const owner = ownerIn((d) => d.marks, name)?.[0];
        if (owner !== e && !usesName(e, name)) return fail(e, `метке ${name}`, new Error(`метки ${name} нет в uses`));
        return owner && markOf(owner, name, args);
      },
      store<T>(section: string) {
        if (!e.def.store?.includes(section)) throw new Error(`раздела ${section} нет в store модуля ${e.name}`);
        return {
          get: () => host.store.get<T>(section),
          set: (value: T) => host.store.set(section, value),
          update: (fn: (old: T | undefined) => T) => host.store.update<T>(section, fn),
        };
      },
      deliver: host.deliver,
      changed: bus.changed,
      toast: host.toast,
      use: bus.use,
      get Slot() {
        return slots.get(e)!;
      },
      get state() {
        return e.def.state;
      },
    } as App;
  }

  const slots = new Map<Entry, App["Slot"]>();
  const modules = {
    core,
    bus,
    entries,
    off,
    fail,
    trap,
    screenOf,
    screenFor,
    markOf,
    reload: host.reload,
    /** Разделы: сначала в порядке оболочки, остальные — следом по списку модулей. */
    sections(): string[] {
      const all = entries.flatMap((e) => Object.entries(e.def.screens ?? {}).flatMap(([name, s]) => (s.nav && s.place !== "top" ? [name] : [])));
      return [...(host.sections ?? []).filter((n) => all.includes(n)), ...all.filter((n) => !host.sections?.includes(n))];
    },
    /** Каждому живому модулю. */
    each(where: string, fn: (d: AppModule) => unknown): unknown[] {
      return entries.flatMap((e) => (off(e) ? [] : [trap(e, where, () => fn(e.def))]));
    },
  };

  // функция модуля: один раз, до гейта; бросила — модуль выключен, на его экранах причина
  for (const part of parts) {
    const e: Entry = { name: part.manifest.name, manifest: part.manifest, def: {}, app: null as never };
    e.app = appFor(e);
    slots.set(e, host.slot(e, modules as Modules));
    entries.push(e);
    try {
      e.def = part.module(e.app);
    } catch (error) {
      fail(e, "старте", error);
      e.def = { screens: Object.fromEntries(Object.keys(part.manifest.provides).map((n) => [n, {}])) };
    }
  }
  return modules;
}
