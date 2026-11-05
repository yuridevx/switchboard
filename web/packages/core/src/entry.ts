// Вход на страницу по шагам: гейт → приглашение из адреса → пропуск → модули → связь. И остановка: экран с причиной вместо приложения.
import type { Address } from "./address.ts";
import type { FleetLink } from "./fleet-link.ts";
import { appGate } from "./gate.ts";
import type { Leave } from "./leave.ts";
import type { Modules } from "./modules.ts";
import { clientName, INVITE, inviteCommand, inviteNumber, keyId, passFrom, redeem } from "./pass.ts";
import type { CoreState, Snapshot, Stop } from "./snapshot.ts";
import type { Platform, StartOptions } from "./types.ts";
import { pageCss } from "./view/shell.tsx";

type Deps = { o: StartOptions; snap: Snapshot; store: NonNullable<StartOptions["store"]>; win: Window };

export type Halt = ReturnType<typeof createHalt>;

/** Остановка приложения с причиной и действия экранов входа и отказа. */
export function createHalt({ o, snap, store, win }: Deps) {
  const clearAddress = () => win.history.replaceState(null, "", win.location.pathname + win.location.search);

  function stopWith(why: string, stop: Stop) {
    console.error(`switchboard: ${why}`);
    snap.set({ full: { ...stop, why } as CoreState["full"] });
  }

  return {
    stopWith,
    clearAddress,
    /** Стереть пропуск и данные приложения на устройстве; дальше — страница без приглашения в адресе: поле приглашения. */
    async wipe() {
      await store.clear();
      clearAddress();
      win.location.reload();
    },
    /** Вставленное приглашение: причина отказа или null — страница перезагружается с пропуском. */
    async acceptInvite(value: string): Promise<string | null> {
      const invite = decodeURIComponent(value.trim().replace(/^.*#(invite=)?/, ""));
      if (!INVITE.test(invite)) return "Это не приглашение: нужен <номер>.<секрет> или ссылка с #invite=.";
      const r = await redeem(o, invite);
      if ("error" in r) return `Приглашение не принято: ${r.error}.`;
      await store.set("key", r.key);
      win.location.reload();
      return null;
    },
    /** Отказ связи: пропуск не принят, приложение устарело или relay остановил соединение. */
    refused(why: string) {
      const key = snap.get().key;
      if (why === "revoked" || why === "bad_key") return stopWith(why, { kind: "pass", why, kid: keyId(key), command: inviteCommand(clientName(key)) });
      if (why === "contract_mismatch") return stopWith(why, { kind: "outdated" });
      stopWith(why, { kind: "connection", why });
    },
  };
}

/** Приглашение из адреса страницы или null. */
function inviteInHash(win: Window): string | null {
  const raw = decodeURIComponent(win.location.hash.replace(/^#/, ""));
  return raw.startsWith("invite=") && INVITE.test(raw.slice(7)) ? raw.slice(7) : null;
}

export async function enter(d: Deps & { platform: Platform; modules: Modules; address: Address; link: FleetLink; leave: Leave; halt: Halt; define(): void }) {
  const { o, snap, store, win, platform, modules, address, link, leave, halt, define } = d;

  define();
  const errors = appGate(modules.list.map((x) => ({ manifest: x.m, module: x.mod })));
  if (errors.length) return halt.stopWith("gate", { kind: "gate", errors });
  if (platform.scope === false) return halt.stopWith("browser", { kind: "browser" });
  modules.register();
  snap.set({ css: pageCss(modules.list.filter((x) => x.mod.css).map((x) => ({ name: x.m.name, css: x.mod.css! }))) });

  const invite = inviteInHash(win);
  if (invite && platform.ios && !platform.standalone) {
    // iPhone: пуши — только у приложения с экрана «Домой», хранилище у него своё: приглашение ждёт в адресе, не погашено
    return snap.set({ full: { kind: "install", number: inviteNumber(invite), why: "install" } });
  }
  if (invite) {
    // адрес очищен при любом исходе
    halt.clearAddress();
    const had = (await store.get<string>("key")) ?? "";
    // то же приглашение уже принято на этом устройстве: иконка экрана «Домой» помнит адрес с #invite=
    if (!passFrom(had, invite)) {
      // ссылку могли подсунуть (ответ сессии, письмо): пропуск устройства меняет только человек; приглашение не гасится
      if (had) return snap.set({ full: { kind: "replace", invite, number: inviteNumber(invite), kid: keyId(had), why: "replace" } });
      const r = await redeem(o, invite);
      if ("error" in r) return halt.stopWith(r.error, { kind: "invite", word: r.error });
      await store.set("key", r.key);
      snap.set({ fresh: true });
    }
  }
  const key = (await store.get<string>("key")) ?? "";
  snap.set({ key });
  // приглашение не доехало (iPhone: адрес не дошёл до экрана «Домой») — вставить вручную
  if (!key) return halt.stopWith("no_key", { kind: "key", command: inviteCommand(o.wide ? "<имя>" : "phone") });

  await modules.startAll();
  snap.set({ tops: [...modules.screens].filter(([, s]) => s.def.place === "top").map(([n]) => n) });
  address.listen();
  const doc = win.document;
  doc.addEventListener("visibilitychange", () => void (doc.visibilityState === "hidden" ? leave.hide() : leave.show()));
  win.addEventListener("pagehide", () => void leave.hide());
  if (doc.visibilityState === "hidden") leave.startAway();
  else link.connect();
}
