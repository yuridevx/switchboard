// App модуля: что ядро даёт модулю. У каждого модуля свой объект: ядро знает, кто зовёт, и сверяет имя с его uses.
import type { Frame } from "@switchboard/relay";
import { serviceAddress } from "@switchboard/protocol";
import type { Address } from "./address.ts";
import type { FleetLink } from "./fleet-link.ts";
import { ownerOf } from "./gate.ts";
import type { Mod, Modules } from "./modules.ts";
import { clientName } from "./pass.ts";
import type { Snapshot } from "./snapshot.ts";
import type { App, Result, StartOptions } from "./types.ts";
import { Slot } from "./view/place.tsx";

export type AppDeps = { o: StartOptions; store: NonNullable<StartOptions["store"]>; snap: Snapshot; modules: Modules; address: Address; link: FleetLink };

export function moduleApp(x: Mod, { o, store, snap, modules, address, link }: AppDeps): App {
  const { fail, call, usesRef, mayOpen } = modules;

  async function ask(name: string, body: Record<string, unknown>, read: boolean): Promise<Result> {
    const ref = usesRef(x, name);
    if (!ref) {
      fail(x, `запросе ${name}`, new Error(`${name} нет в uses`));
      return { ok: false, error: "module_error" };
    }
    // версия — названная в вызове как есть, иначе из uses: одно правило с ядром Host
    const f: Frame = { ...body, type: name, v: (body.v as number | undefined) ?? x.m.uses[ref] };
    // Worker — .имя, POST по адресу из сборки; имя и версию проверяет получатель и отвечает словом
    const owner = ownerOf(ref);
    if (Object.hasOwn(o.workers, owner)) f.to = serviceAddress(owner);
    return link.request(f, read);
  }

  return {
    get name() {
      return clientName(snap.get().key);
    },
    get state() {
      return x.mod.state;
    },
    wide: !!o.wide,
    application: o.application,
    address: link.address,
    request: ((name: string, body: Record<string, unknown> = {}) => ask(name, body, false)) as App["request"],
    read: ((name: string, body: Record<string, unknown> = {}) => ask(name, body, true)) as App["read"],
    open(screen, params = {}) {
      if (!mayOpen(x, screen)) return fail(x, `открытии ${screen}`, new Error(`экрана ${screen} нет в uses`));
      address.go(screen, params);
    },
    run(command, params = {}) {
      if (!mayOpen(x, command)) return fail(x, `команде ${command}`, new Error(`команды ${command} нет в uses`));
      const c = modules.commands.get(command);
      if (c) call(c.owner, `команде ${command}`, () => c.def.run(params));
    },
    placed(place, params = {}) {
      if (x.m.provides[place] === undefined) {
        fail(x, `месте ${place}`, new Error(`места ${place} нет в provides`));
        return [];
      }
      return [...modules.screens, ...modules.commands]
        .filter(([name, s]) => s.def.place === place && !s.owner.failed && (!s.def.show || call(s.owner, `месте ${name}`, () => s.def.show!(params)) === true))
        .map(([name, s]) => ({ name, label: s.def.label ?? name }));
    },
    back: address.back,
    can(machine, name) {
      const m = snap.get().roster?.machines.find((y) => y.machine === machine);
      return m ? (m.contract ?? {})[name] !== undefined : null;
    },
    roster: () => snap.get().roster,
    worker: (name) => (Object.hasOwn(o.workers, name) ? o.workers[name] : null),
    current() {
      const { current, master } = snap.get();
      return current ? { screen: current.screen, params: { ...current.params }, master } : null;
    },
    link: () => snap.get().conn,
    mark: ((name: string, ...args: string[]) => {
      if (!usesRef(x, name) && !x.mod.marks?.[name]) {
        fail(x, `метке ${name}`, new Error(`метки ${name} нет в uses`));
        return undefined;
      }
      const owner = modules.markOwner(name);
      return owner ? call(owner, `метке ${name}`, () => owner.mod.marks![name](...args)) : undefined;
    }) as App["mark"],
    store<T>(section: string) {
      if (!x.mod.store?.includes(section)) throw new Error(`раздела ${section} нет в store модуля ${x.m.name}`);
      return {
        get: () => store.get<T>(section),
        set: (v: T) => store.set(section, v),
        update: (fn: (old: T | undefined) => T) => store.update<T>(section, fn),
      };
    },
    deliver: link.deliver,
    changed: snap.changed,
    toast: snap.toast,
    use: snap.use,
    Slot,
  };
}
