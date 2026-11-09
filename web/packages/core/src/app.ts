// App модуля: что ядро даёт модулю; у каждого модуля свой объект, поэтому ядро знает, кто зовёт.
import { createElement } from "react";
import { serviceAddress } from "@switchboard/protocol";
import type { Frame } from "@switchboard/relay";
import type { Link } from "./link.ts";
import type { Mod, Modules } from "./modules.ts";
import type { Page } from "./page.ts";
import type { Route } from "./route.ts";
import { Slot } from "./view/place.tsx";
import type { App, Params, Result, Section, SlotProps } from "./types.ts";
import { keyName } from "./pass.ts";

export type Core = { page: Page; mods: Modules; route: Route; link: Link; toast(text: string, tone?: "ok" | "bad"): void };

export function appOf(mod: Mod, core: Core): App {
  const { page, mods, route, link } = core;
  const { store, o } = page;

  function ask<T>(name: string, body: Record<string, unknown> | undefined, read: boolean): Promise<Result<T>> {
    const use = mods.uses(mod, name);
    if (!use) {
      mods.refuse(mod, `запроса ${name} нет в uses`);
      return Promise.resolve({ ok: false, error: "module_error" });
    }
    const to = Object.hasOwn(o.workers, use.owner) ? { to: serviceAddress(use.owner) } : {};
    return link.request({ type: name, v: use.v, ...to, ...body } as Frame, read).then((r) => {
      const { type: _t, id: _i, ...result } = r;
      return result as Result<T>;
    });
  }

  return {
    get name() {
      return page.key ? keyName(page.key) : "";
    },
    address: () => page.address,
    application: o.application,
    wide: page.wide,
    request: (name, body) => ask(name, body, false),
    read: (name, body) => ask(name, body, true),
    open(screen, params) {
      if (mods.reaches(mod, mods.screens.get(screen), screen)) route.open(screen, params);
      else mods.refuse(mod, `экрана ${screen} нет в uses`);
    },
    run(command, params: Params = {}) {
      const c = mods.commands.get(command);
      if (!mods.reaches(mod, c, command)) return mods.refuse(mod, `команды ${command} нет в uses`);
      if (c) mods.call(c.mod, `команде ${command}`, () => c.def.run(params));
    },
    placed(place, params = {}) {
      if (!Object.hasOwn(mod.manifest.provides, place)) {
        mods.refuse(mod, `места ${place} нет в provides`);
        return [];
      }
      return mods.inPlace(place, params).map((x) => ({ name: x.name, label: x.def.label ?? x.name }));
    },
    back: route.back,
    can(machine, name) {
      const m = page.roster?.machines.find((x) => x.machine === machine);
      return m ? Object.hasOwn(m.contract ?? {}, name) : null;
    },
    roster: () => page.roster,
    worker: (name) => (Object.hasOwn(o.workers, name) ? o.workers[name] : null),
    current: () => page.current,
    link: () => page.link,
    mark(name: string, ...args: string[]) {
      if (!Object.hasOwn(mod.def.marks ?? {}, name) && !mods.uses(mod, name)) return void mods.refuse(mod, `метки ${name} нет в uses`);
      return mods.mark(name, args);
    },
    store<T>(section: string): Section<T> {
      if (!mod.def.store?.includes(section)) throw new Error(`раздела ${section} нет в store модуля ${mod.name}`);
      return {
        get: () => store.get<T>(section),
        set: (value) => store.set(section, value),
        update: (fn) => store.update<T>(section, fn),
      };
    },
    deliver: (f, ctx) => link.deliver(f, ctx?.open),
    changed: page.changed,
    toast: core.toast,
    use: page.use,
    Slot: (props: SlotProps) => createElement(Slot, { ...props, from: mod }),
    get state() {
      return mod.def.state;
    },
  };
}
