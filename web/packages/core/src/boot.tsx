// Старт приложения по шагам: гейт → пропуск → модули → связь. И остановка: экран с причиной вместо приложения.
import { appGate } from "./gate.ts";
import type { Lifecycle } from "./lifecycle.ts";
import type { Link } from "./link.ts";
import type { Mod } from "./mod.ts";
import { clientName, INVITE_RE, inviteCommand, keyId, redeem } from "./pass.ts";
import type { Registry } from "./registry.ts";
import type { Router } from "./router.ts";
import type { CoreStore, Stop } from "./state.ts";
import type { App, Platform, StartOptions } from "./types.ts";
import { pageCss } from "./view/shell.tsx";

type Deps = { state: CoreStore; store: NonNullable<StartOptions["store"]>; win: Window };

/** Стереть пропуск и данные приложения на устройстве; дальше — страница без приглашения в адресе: поле приглашения. */
async function wipe({ store, win }: Pick<Deps, "store" | "win">) {
  await store.clear();
  win.history.replaceState(null, "", win.location.pathname + win.location.search);
  win.location.reload();
}

/** Остановка приложения с причиной; действия экранов входа и отказа. */
export function createHalt(d: Deps & { o: StartOptions }) {
  const stopWith = (why: string, stop: Stop) => {
    console.error(`switchboard: ${why}`);
    d.state.set({ stopped: why, full: stop });
  };
  return {
    stopWith,
    wipe: () => wipe(d),
    /** Вставленное приглашение: причина отказа или null — страница перезагружается с пропуском. */
    async acceptInvite(value: string): Promise<string | null> {
      const v = decodeURIComponent(value.trim().replace(/^.*#(invite=)?/, ""));
      if (!INVITE_RE.test(v)) return "Это не приглашение: нужен <номер>.<секрет> или ссылка с #invite=.";
      const r = await redeem(d.o, v);
      if ("error" in r) return `Приглашение не принято: ${r.error}.`;
      await d.store.set("key", r.key);
      d.win.location.reload();
      return null;
    },
    refused(why: string) {
      const key = d.state.get().key;
      if (why === "revoked" || why === "bad_key") return stopWith(why, { kind: "pass", why, kid: keyId(key), command: inviteCommand(clientName(key)) });
      if (why === "contract_mismatch") return stopWith(why, { kind: "outdated" });
      return stopWith(why, { kind: "connection", why });
    },
  };
}

export async function boot(d: Deps & { o: StartOptions; platform: Platform; registry: Registry; appFor(x: Mod): App; router: Router; link: Link; life: Lifecycle; stopWith(why: string, stop: Stop): void }) {
  const { o, state, store, win, platform, registry, appFor, router, link, life, stopWith } = d;
  const doc = win.document;

  const errors = appGate(o.parts);
  if (errors.length) return stopWith("gate", { kind: "gate", errors });
  if (platform.scope === false) return stopWith("browser", { kind: "browser" });
  registry.add(o.parts, appFor);
  state.set({ css: pageCss(registry.mods.filter((x) => x.mod.css).map((x) => ({ name: x.m.name, css: x.mod.css! }))) });

  const raw = decodeURIComponent(win.location.hash.replace(/^#/, ""));
  const fromHash = raw.startsWith("invite=") && INVITE_RE.test(raw.slice(7)) ? raw.slice(7) : null;
  if (fromHash && platform.ios && !platform.standalone) {
    // iPhone: пуши — только у приложения с экрана «Домой», хранилище у него своё — приглашение ждёт в адресе, не погашено
    return state.set({ stopped: "install", full: { kind: "install", number: fromHash.split(".")[0] } });
  }
  if (fromHash) {
    // приглашение — у gate: секрет пропуска рождается там и приходит один раз; адрес очищен в любом исходе
    win.history.replaceState(null, "", win.location.pathname + win.location.search);
    // то же приглашение уже принято на этом устройстве: иконка экрана «Домой» помнит адрес с #invite= — пропуск в хранилище
    const had = (await store.get<string>("key")) ?? "";
    const number = fromHash.split(".")[0];
    if (had.split(".")[2] !== number) {
      // ссылку могли подсунуть (ответ сессии, письмо): пропуск устройства меняет только человек; приглашение не гасится
      if (had) return state.set({ stopped: "replace", full: { kind: "replace", invite: fromHash, number, kid: keyId(had) } });
      const r = await redeem(o, fromHash);
      if ("error" in r) return stopWith(r.error, { kind: "invite", word: r.error });
      await store.set("key", r.key);
      state.set({ fresh: true });
    }
  }
  const key = (await store.get<string>("key")) ?? "";
  state.set({ key });
  if (!key) {
    // приглашение не доехало (iPhone: адрес не дошёл до экрана «Домой») — вставить вручную
    return stopWith("no_key", { kind: "key", command: inviteCommand(o.wide ? "<имя>" : "phone") });
  }

  await registry.startAll();
  state.set({ tops: [...registry.screens].filter(([, s]) => s.def.place === "top").map(([n]) => n), connecting: true });
  router.listen();
  doc.addEventListener("visibilitychange", () => (doc.visibilityState === "hidden" ? life.hide() : life.show()));
  win.addEventListener("pagehide", () => void life.hide());
  if (doc.visibilityState === "hidden") life.startHidden();
  else link.connect();
}
