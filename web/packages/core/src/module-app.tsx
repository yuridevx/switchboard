// App модуля: что ядро даёт модулю. У каждого модуля свой объект: ядро знает, кто зовёт, и сверяет имя с его uses.
import type { Frame } from "@switchboard/relay";
import { serviceAddress } from "@switchboard/protocol";
import type { Bus } from "./bus.ts";
import { ownerOf } from "./gate.ts";
import type { Link } from "./link.ts";
import type { Mod } from "./mod.ts";
import { clientName } from "./pass.ts";
import type { Registry } from "./registry.ts";
import type { Router } from "./router.ts";
import type { CoreStore } from "./state.ts";
import type { App, Result, StartOptions } from "./types.ts";
import type { Core } from "./view/core.ts";
import { Slot } from "./view/place.tsx";

export type AppDeps = { o: StartOptions; store: NonNullable<StartOptions["store"]>; state: CoreStore; registry: Registry; router: Router; link: Link; bus: Bus; toast: App["toast"]; core: Core };

export function moduleApp(x: Mod, d: AppDeps): App {
  const { o, store, state, registry, router, link, bus, toast, core } = d;
  const { fail, call, usesRef, mayOpen, lookup } = registry;

  async function request(n: string, body: Record<string, unknown> = {}): Promise<Result> {
    const ref = usesRef(x, n);
    if (!ref) {
      fail(x, `запросе ${n}`, new Error(`${n} нет в uses`));
      return { ok: false, error: "module_error" };
    }
    const owner = ownerOf(ref);
    // версия — названная в вызове как есть, иначе из uses: одно правило с ядром Host
    const f: Frame = { ...body, type: n, v: (body.v as number | undefined) ?? x.m.uses[ref] };
    // Worker — .имя, POST по адресу из сборки; имя и версию проверяет получатель и отвечает словом
    if (Object.hasOwn(o.workers, owner)) f.to = serviceAddress(owner);
    return link.request(f);
  }

  return {
    get name() {
      return clientName(state.get().key);
    },
    get state() {
      return x.mod.state;
    },
    wide: !!o.wide,
    application: o.application,
    request: request as App["request"],
    open: (screen, params = {}) => {
      if (!mayOpen(x, screen)) return fail(x, `открытии ${screen}`, new Error(`экрана ${screen} нет в uses`));
      const s = lookup(screen);
      if (s?.def.run) return void call(s.owner, `команде ${screen}`, () => s.def.run!(params));
      router.go(screen, params);
    },
    placed: (at, params = {}) => {
      if (x.m.provides[at] === undefined) {
        fail(x, `месте ${at}`, new Error(`места ${at} нет в provides`));
        return [];
      }
      return [...registry.screens]
        .filter(([n, s]) => s.def.place === at && !s.owner.failed && (!s.def.show || call(s.owner, `экране ${n}`, () => s.def.show!(params)) === true))
        .map(([n, s]) => ({ screen: n, label: s.def.label ?? n }));
    },
    back: router.back,
    can: (machine, n) => {
      const m = state.get().roster?.machines.find((y) => y.machine === machine);
      return m ? (m.contract ?? {})[n] !== undefined : null;
    },
    roster: () => state.get().roster,
    worker: (n) => (Object.hasOwn(o.workers, n) ? o.workers[n] : null),
    current: () => {
      const { current: c, master } = state.get();
      return c ? { screen: c.screen, params: { ...c.params }, master } : null;
    },
    link: () => state.get().conn,
    mark: ((n: string, ...args: string[]) => {
      if (!usesRef(x, n) && !x.mod.marks?.[n]) {
        fail(x, `метке ${n}`, new Error(`метки ${n} нет в uses`));
        return undefined;
      }
      const ow = registry.markOwner(n);
      return ow ? call(ow, `метке ${n}`, () => ow.mod.marks![n](...args)) : undefined;
    }) as App["mark"],
    store: <T,>(section: string) => {
      if (!x.mod.store?.includes(section)) throw new Error(`раздела ${section} нет в store модуля ${x.m.name}`);
      return {
        get: () => store.get<T>(section),
        set: (v: T) => store.set(section, v),
        update: (fn: (old: T | undefined) => T) => store.update<T>(section, fn),
      };
    },
    deliver: link.deliver,
    changed: bus.changed,
    toast,
    use: bus.useSelect,
    Slot,
  };
}
