// Вход аккаунта по ссылке и коду коротким claude без сессии и проверка входа командой claude auth status.
// Токен не используем: вход и его обновление живут в папке аккаунта у самого claude.
import { mkdirSync } from "node:fs";
import { CALL_MS, READ_MS, within } from "@switchboard/protocol";
import { refuse } from "@switchboard/host";
import type { Frame, Host, Module, Probe } from "@switchboard/host";
import { sec, type Book } from "./book.ts";

/** Предел claude auth status. */
const STATUS_MS = READ_MS;
/** Предел вызова входа у процесса claude. */
const LOGIN_MS = CALL_MS;
/** Сколько процесс входа ждёт код: человек открывает ссылку, входит и вставляет код. Срока ссылки SDK не называет; повтор входа даёт новую. */
const LOGIN_WAIT_MS = 30 * 60_000;
const NAME = /^[A-Za-z0-9_-]+$/;
const noAnswer = `не ответил за ${LOGIN_MS / 1000} с`;

type Open = { p: Probe; state: string | null; late?: ReturnType<typeof setTimeout> };
type Who = { email?: string; subscriptionType?: string };

export function makeSignIn(host: () => Host, book: Book) {
  /** процессы входа: имя → короткий claude, ждущий код */
  const open = new Map<string, Open>();
  let checking = false;
  let stopping = false;

  function close(name: string): void {
    const l = open.get(name);
    if (l?.late) clearTimeout(l.late);
    l?.p.close();
    open.delete(name);
  }

  /** Вошёл ли: вход 0 без JSON — вошёл; не ответил за предел — исключение: что с входом, неизвестно. */
  async function loggedIn(who: string, env: Record<string, string>): Promise<boolean> {
    const r = await within(host().cli(["auth", "status"], { env }), `${who}: auth status не ответил за ${STATUS_MS / 1000} с`, STATUS_MS);
    if (r.code !== 0) return false;
    try {
      return (JSON.parse(r.out) as { loggedIn?: boolean }).loggedIn !== false;
    } catch {
      return true;
    }
  }

  /** Проверка всех аккаунтов: пропал — login none и строка журнала. Прежняя ещё идёт — следующий раз. */
  async function check(): Promise<void> {
    if (checking) return;
    checking = true;
    try {
      for (const [name, a] of Object.entries(book.accounts())) {
        if (stopping) return;
        if (a.login === "pending") continue;
        const ok = await loggedIn(name, book.envOf(name));
        const at = sec();
        book.edit(name, (cur) => cur && { ...cur, login: cur.login === "pending" ? "pending" : ok ? "ok" : "none", checked: at });
        if (!ok && a.login === "ok") host().log({ kind: "stop", ev: "login_lost", account: name, why: `${name}: вход пропал` });
      }
    } finally {
      checking = false;
    }
  }

  const requests: Required<Module>["requests"] = {
    async "machine.login"(f: Frame) {
      const name = f.account;
      if (typeof name !== "string" || !NAME.test(name)) throw refuse("bad_frame", "имя аккаунта — латиница, цифры, - и _");
      close(name); // повтор закрывает прежний процесс
      mkdirSync(book.accountDir(name), { recursive: true });
      const p = host().probe({ env: book.envOf(name) });
      open.set(name, { p, state: null });
      let url: string;
      try {
        const r = (await within(p.sdk("claudeAuthenticate", true), noAnswer, LOGIN_MS)) as { manualUrl?: string };
        url = r.manualUrl ?? "";
      } catch (e) {
        close(name);
        throw refuse("login_failed", `${name}: claudeAuthenticate — ${(e as Error).message}`);
      }
      const late = setTimeout(() => {
        close(name);
        book.edit(name, (cur) => cur && { ...cur, login: "none" });
        host().log({ kind: "refuse", ev: "login", account: name, why: `${name}: срок входа вышел — кода нет за ${LOGIN_WAIT_MS / 60_000} мин` });
      }, LOGIN_WAIT_MS);
      open.set(name, { p, late, state: new URL(url, "https://claude.ai").searchParams.get("state") });
      book.edit(name, (cur) => ({ ...(cur ?? { limits: {} }), login: "pending" }));
      host().log({ ev: "login", account: name, why: `${name}: вход начат` });
      return { url };
    },

    async "machine.login_code"(f: Frame) {
      const name = f.account as string;
      const l = typeof name === "string" ? open.get(name) : undefined;
      if (!l) throw refuse("not_started", `${String(name)}: входа нет — Host перезапускался, вход начат заново или срок вышел`);
      // код — секрет: только в тело вызова SDK, не в журнал и не в аргументы процессов
      const raw = String(f.code ?? "");
      const hash = raw.indexOf("#");
      const code = hash >= 0 ? raw.slice(0, hash) : raw;
      const state = hash >= 0 ? raw.slice(hash + 1) : l.state;
      let who: Who | undefined;
      try {
        who = ((await within(l.p.sdk("claudeOAuthCallback", code, state), noAnswer, LOGIN_MS)) as { account?: Who } | undefined)?.account;
      } catch (e) {
        close(name);
        book.edit(name, (cur) => cur && { ...cur, login: "none" });
        throw refuse("bad_code", `${name}: claude не принял код — ${(e as Error).message.replaceAll(raw, "…").replaceAll(code, "…")}`);
      }
      if (!who?.email) {
        try {
          who = ((await within(l.p.sdk("accountInfo"), noAnswer, LOGIN_MS)) as Who | undefined) ?? who;
        } catch (e) {
          host().log({ kind: "refuse", ev: "login", account: name, why: `${name}: accountInfo — ${(e as Error).message}` });
        }
      }
      close(name);
      let ok = false;
      if (book.accounts()[name]) {
        try {
          ok = await loggedIn(name, book.envOf(name));
        } catch (e) {
          host().log({ kind: "refuse", ev: "login", account: name, why: (e as Error).message });
        }
      }
      book.edit(name, (cur) => ({
        ...(cur ?? { limits: {} }),
        login: ok ? "ok" : "none",
        checked: sec(),
        ...(who?.email ? { email: who.email } : {}),
        ...(who?.subscriptionType ? { plan: who.subscriptionType } : {}),
      }));
      host().log({ ev: "login", account: name, why: ok ? `${name}: вошёл` : `${name}: claude принял код, но auth status — не вошёл` });
      return { email: who?.email ?? null, plan: who?.subscriptionType ?? null };
    },
  };

  return {
    requests,
    check,
    /** Есть ли у машины общий вход: claude без папки аккаунта. */
    sharedLogin: () => loggedIn("общий вход", {}),
    close,
    start() {
      // процесс входа умер вместе с прежним Host
      for (const [name, a] of Object.entries(book.accounts())) if (a.login === "pending") book.edit(name, (cur) => cur && { ...cur, login: "none" });
    },
    stop() {
      stopping = true;
      for (const name of [...open.keys()]) close(name);
    },
  };
}
