// Модуль logins: входы Claude на машине и слоты. У каждого аккаунта своя папка Claude (CLAUDE_CONFIG_DIR): вход, почта,
// тариф. Слот — ссылка по имени (main, bot) на папку аккаунта; сессии слота получают её в CLAUDE_SECURESTORAGE_CONFIG_DIR
// и читают вход перед каждым вызовом модели. Поэтому один аккаунт стоит хоть в нескольких слотах, а токен, обновлённый claude,
// сразу ложится домой.
import { rmSync } from "node:fs";
import { refuse } from "@switchboard/host";
import type { Ctx, Frame, Host, Module, Session } from "@switchboard/host";
import { makeBook, sec } from "./book.ts";
import { shown, stale } from "./limits.ts";
import { makeSignIn } from "./signin.ts";
import { makeSlots } from "./slots.ts";
import { makeUsage } from "./usage.ts";

export type { Machine } from "./book.ts";
export type { Account, Accounts, Window } from "./limits.ts";

/** Проверка входа — раз в 2 мин, как в claude-fleet. */
const CHECK_MS = 120_000;

export function make() {
  let host: Host;
  let timer: ReturnType<typeof setInterval> | null = null;
  const getHost = () => host;
  const book = makeBook(getHost);
  const usage = makeUsage(getHost, book);
  const signIn = makeSignIn(getHost, book);
  const slots = makeSlots(getHost, book, usage, signIn.sharedLogin);

  const requests: Required<Module>["requests"] = {
    ...signIn.requests,
    ...slots.requests,

    async "machine.accounts"(f: Frame) {
      if (typeof f.max_age === "number") {
        const age = f.max_age;
        const due = Object.entries(book.accounts()).filter(([, a]) => a.login === "ok" && stale(a, age, sec()));
        await Promise.all(due.map(([name]) => usage.poll(name)));
      }
      const now = sec();
      return {
        accounts: Object.fromEntries(Object.entries(book.accounts()).map(([name, a]) => [name, shown(a, now)])),
        slots: Object.fromEntries(Object.entries(book.orders()).map(([name, order]) => [name, { account: slots.whoIn(name), order, wait: slots.waitOf(name), sessions: slots.sessionsOf(name) }])),
      };
    },

    /** Удалить аккаунт одним запросом: сменить в слотах, убрать из порядка, стереть. */
    "machine.account_remove"(f: Frame, ctx: Ctx) {
      return slots.queue(async () => {
        const name = f.account;
        if (typeof name !== "string" || !book.accounts()[name]) throw refuse("no_account", `аккаунта ${String(name)} на машине нет`);
        await slots.evacuate(name, typeof f.next === "string" && f.next ? f.next : null, ctx);
        signIn.close(name);
        usage.cancel(name);
        // только своя папка аккаунта; claude auth logout не зовём — он чистит общие настройки
        try {
          rmSync(book.accountDir(name), { recursive: true, force: true });
        } catch (e) {
          throw refuse("account_dir_busy", `${name}: папка аккаунта занята — ${(e as Error).message}; повторите запрос`);
        }
        book.edit(name, () => undefined);
        host.log({ ev: "account_remove", account: name, why: `${name}: папка аккаунта удалена` });
        return { wiped: true };
      });
    },
  };

  const module = {
    requests,
    fields: slots.fields,
    opening: slots.opening,
    session: slots.session,
    on: slots.on,
    start(h: Host) {
      host = h;
      signIn.start();
      timer = setInterval(() => void signIn.check().catch((e) => host.log({ kind: "refuse", ev: "check", why: (e as Error).message })), CHECK_MS);
      slots.start();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      slots.stop();
      signIn.stop();
      usage.stop();
    },
  };
  return module as unknown as Module & Required<Pick<Module, "requests">> & { opening(s: Session, req: Record<string, unknown>): Promise<void> };
}
