// Старт приложения по шагам: гейт → пропуск → модули → связь. И остановка: экран с причиной вместо приложения.
import type { ReactNode } from "react";
import { appGate } from "./gate.ts";
import type { Lifecycle } from "./lifecycle.ts";
import type { Link } from "./link.ts";
import type { Mod } from "./mod.ts";
import { clientName, INVITE_RE, inviteCommand, keyId, redeem } from "./pass.ts";
import type { Registry } from "./registry.ts";
import type { Router } from "./router.ts";
import type { CoreStore } from "./state.ts";
import type { App, Platform, StartOptions } from "./types.ts";
import { pageCss } from "./view/shell.tsx";
import { browserOld, connectionStopped, gateRefused, inviteRefused, installHere, KeyPrompt, outdated, passRefused } from "./view/stops.tsx";

type Deps = { state: CoreStore; store: NonNullable<StartOptions["store"]>; win: Window };

/** Стереть пропуск и данные приложения на устройстве; дальше — страница без приглашения в адресе: поле приглашения. */
async function wipe({ store, win }: Pick<Deps, "store" | "win">) {
  await store.clear();
  win.history.replaceState(null, "", win.location.pathname + win.location.search);
  win.location.reload();
}

/** Остановка приложения с причиной. stopTick — снять счётчик полосы связи. */
export function createHalt(d: Deps & { stopTick(): void }) {
  const stopWith = (why: string, node: ReactNode) => {
    console.error(`switchboard: ${why}`);
    d.stopTick();
    d.state.set({ stopped: why, full: node });
  };
  const reload = () => d.win.location.reload();
  return {
    stopWith,
    refused(why: string) {
      const key = d.state.get().key;
      if (why === "revoked" || why === "bad_key") return stopWith(why, passRefused(why, keyId(key), inviteCommand(clientName(key)), () => void wipe(d)));
      if (why === "contract_mismatch") return stopWith(why, outdated(reload));
      return stopWith(why, connectionStopped(why, reload));
    },
  };
}

export async function boot(d: Deps & { o: StartOptions; platform: Platform; registry: Registry; appFor(x: Mod): App; router: Router; link: Link; life: Lifecycle; stopWith(why: string, node: ReactNode): void }) {
  const { o, state, store, win, platform, registry, appFor, router, link, life, stopWith } = d;
  const doc = win.document;

  const errors = appGate(o.parts);
  if (errors.length) return stopWith("gate", gateRefused(errors));
  if (platform.scope === false) return stopWith("browser", browserOld());
  registry.add(o.parts, appFor);
  state.set({ css: pageCss(registry.mods.filter((x) => x.mod.css).map((x) => ({ name: x.m.name, css: x.mod.css! }))) });

  const raw = decodeURIComponent(win.location.hash.replace(/^#/, ""));
  const fromHash = raw.startsWith("invite=") && INVITE_RE.test(raw.slice(7)) ? raw.slice(7) : null;
  if (fromHash && platform.ios && !platform.standalone) {
    // iPhone: пуши — только у приложения с экрана «Домой», хранилище у него своё — приглашение ждёт в адресе, не погашено
    return state.set({ stopped: "install", full: installHere(fromHash.split(".")[0]) });
  }
  if (fromHash) {
    // приглашение — у gate: секрет пропуска рождается там и приходит один раз; адрес очищен в любом исходе
    win.history.replaceState(null, "", win.location.pathname + win.location.search);
    // то же приглашение уже принято на этом устройстве: иконка экрана «Домой» помнит адрес с #invite= — пропуск в хранилище
    const had = (await store.get<string>("key")) ?? "";
    if (had.split(".")[2] !== fromHash.split(".")[0]) {
      const r = await redeem(o, fromHash);
      if ("error" in r) return stopWith(r.error, inviteRefused(r.error, () => void wipe(d)));
      await store.set("key", r.key);
      state.set({ fresh: true });
    }
  }
  const key = (await store.get<string>("key")) ?? "";
  state.set({ key });
  if (!key) {
    // приглашение не доехало (iPhone: адрес не дошёл до экрана «Домой») — вставить вручную
    const accept = async (value: string): Promise<string | null> => {
      const v = decodeURIComponent(value.trim().replace(/^.*#(invite=)?/, ""));
      if (!INVITE_RE.test(v)) return "Это не приглашение: нужен <номер>.<секрет> или ссылка с #invite=.";
      const r = await redeem(o, v);
      if ("error" in r) return `Приглашение не принято: ${r.error}.`;
      await store.set("key", r.key);
      win.location.reload();
      return null;
    };
    return stopWith("no_key", <KeyPrompt command={inviteCommand(o.wide ? "<имя>" : "phone")} accept={accept} />);
  }

  await registry.startAll();
  state.set({ tops: [...registry.screens].filter(([, s]) => s.def.place === "top").map(([n]) => n), connecting: true });
  router.listen();
  doc.addEventListener("visibilitychange", () => (doc.visibilityState === "hidden" ? life.hide() : life.show()));
  win.addEventListener("pagehide", () => void life.hide());
  if (doc.visibilityState === "hidden") life.startHidden();
  else link.connect();
}
