// Пропуск страницы: из хранилища или из приглашения в адресе; приём у gate; замена и зачистка.
import { withLimit, within } from "@switchboard/protocol";
import type { Page } from "./page.ts";
import type { Route } from "./route.ts";

const LIMIT_MS = 30_000;

/** Номер приглашения и пропуска: их и показываем, секрет — никогда. */
export const inviteNumber = (invite: string) => invite.split(".")[0];
/** Пропуск без секрета: client.phone.k2a9. */
export const keyId = (key: string) => key.split(".").slice(0, 3).join(".");

const inviteIn = (text: string) => /#invite=(.+)$/.exec(text)?.[1] ?? null;

export type Pass = ReturnType<typeof createPass>;

export function createPass(page: Page, route: Route, stop: (word: string, invite?: boolean) => void) {
  const { o, win, store } = page;

  /** gate.redeem; отказ — слово. */
  async function redeem(invite: string): Promise<{ key: string } | { word: string }> {
    const ask = async () => {
      const res = await (o.fetch ?? fetch)(o.workers.gate, { method: "POST", body: JSON.stringify({ type: "gate.redeem", v: 1, id: crypto.randomUUID(), invite }) });
      const r = (await res.json()) as { ok: true; result: { key: string } } | { ok: false; error: string };
      return r.ok ? { key: r.result.key } : { word: r.error };
    };
    return withLimit(ask(), LIMIT_MS, () => ({ word: "gate_unavailable" })).catch(() => ({ word: "gate_unavailable" }));
  }

  /** Принять и перезагрузиться; отказ — под кнопкой. */
  async function accept(invite: string) {
    const r = await redeem(invite);
    if ("word" in r) {
      page.note = `Приглашение не принято: ${r.word}.`;
      return page.changed();
    }
    await store.set("key", r.key);
    win.location.reload();
  }

  return {
    /** Пропуск страницы; нет — страница остановлена с причиной. */
    async enter(): Promise<string | null> {
      const had = await within(store.get<string>("key"), "хранилище не ответило за 30 с", LIMIT_MS);
      const invite = inviteIn(win.location.hash);
      if (!invite) return had ?? (stop("no_key"), null);
      page.invite = invite;
      if (page.platform.ios && !page.platform.standalone) return stop("install"), null;
      route.clear();
      if (had) {
        if (had.split(".")[2] === inviteNumber(invite)) return had;
        page.key = had;
        return stop("replace"), null;
      }
      const r = await redeem(invite);
      if ("word" in r) return stop(r.word, true), null;
      await store.set("key", r.key);
      page.saved = true;
      return r.key;
    },
    /** Вставленное приглашение: ссылка или <номер>.<секрет>. */
    paste(text: string) {
      const invite = inviteIn(text) ?? text.trim();
      if (/^[^.\s]+\.[^.\s]+$/.test(invite)) return accept(invite);
      page.note = "Это не приглашение: нужен <номер>.<секрет> или ссылка с #invite=.";
      page.changed();
    },
    replace: () => accept(page.invite!),
    /** Стереть всё и начать с чистой страницы. */
    async wipe() {
      await store.clear();
      route.clear();
      win.location.reload();
    },
  };
}
