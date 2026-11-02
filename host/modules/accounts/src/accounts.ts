// Модуль accounts: аккаунты Claude на машине. У каждого аккаунта своя папка Claude (CLAUDE_CONFIG_DIR):
// вход, почта, тариф. Вход всегда лежит в своей папке; слот — ссылка на неё (junction на Windows, symlink на Linux).
// Поэтому один аккаунт стоит хоть в нескольких слотах, а токен, обновлённый claude, сразу ложится домой.
// Ссылку перевешивает только accounts — под блокировкой обновления входа claude (.oauth_refresh.lock в папке входа):
// claude держит её на время обновления (опыт 1 ноя: ~0,7 с), свежую чужую ждёт, поэтому подмена не рвёт обновление.
// С claude говорит короткими процессами без сессии (host.probe) и командой claude auth status (host.cli).
import { existsSync, lstatSync, mkdirSync, renameSync, rmdirSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import type { Stats } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { refuse } from "@switchboard/host";
import type { Frame, Host, Module, Probe } from "@switchboard/host";

/** Окно лимита: доля 0…1, час сброса и откуда значение (event — поток слота, poll — свой опрос, иначе имя машины). */
export type Window = { utilization: number; resetsAt: number; at: number; src: string };

/** Запись аккаунта в хранилище. links — папки слотов, чьи ссылки ведут на папку аккаунта. */
export type Account = {
  login: "ok" | "none" | "pending";
  links: string[];
  email?: string;
  plan?: string;
  checked?: number;
  limits: Record<string, Window>;
  err?: string;
};

export type Accounts = Record<string, Account>;

/** Файл входа claude в папке Claude (или в CLAUDE_SECURESTORAGE_CONFIG_DIR). */
export const CREDENTIALS = ".credentials.json";
/** Блокировка обновления входа claude — папка рядом с файлом входа (mkdir). */
export const REFRESH_LOCK = ".oauth_refresh.lock";
/** Сколько ждать, пока claude обновляет вход: свою блокировку он держит меньше секунды. */
export const LOCK_WAIT_MS = 10_000;
const USAGE = "usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET";
const NAME = /^[A-Za-z0-9_-]+$/;
/** Проверка входа — раз в 2 мин, как в claude-fleet. */
export const CHECK_MS = 120_000;

const sec = () => Math.floor(Date.now() / 1000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const lstat = (p: string): Stats | null => {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
};

/** Убрать ссылку слота или пустую папку на её месте. Не рекурсивно: папка аккаунта за ссылкой не трогается. */
export function unlinkSlot(p: string): void {
  const st = lstat(p);
  if (!st) return;
  if (st.isSymbolicLink()) {
    try {
      unlinkSync(p);
    } catch {
      rmdirSync(p); // junction на Windows
    }
  } else if (st.isDirectory()) {
    try {
      rmdirSync(p);
    } catch {
      throw refuse("slot_dir_busy", `${p}: на месте ссылки слота папка с файлами`);
    }
  } else unlinkSync(p);
}

/** Ссылка слота на папку: Linux — symlink во временное имя и rename (атомарно); Windows — junction заново (rename поверх — EPERM). */
export function linkSlot(slot: string, target: string): void {
  mkdirSync(dirname(slot), { recursive: true });
  if (process.platform === "win32") {
    unlinkSlot(slot);
    symlinkSync(target, slot, "junction");
    return;
  }
  if (!lstat(slot)?.isSymbolicLink()) unlinkSlot(slot);
  const tmp = `${slot}.link`;
  unlinkSlot(tmp);
  symlinkSync(target, tmp);
  renameSync(tmp, slot);
}

/** fn под блокировкой обновления входа в папке dir. Держит её claude дольше LOCK_WAIT_MS — refresh_locked. */
async function locked<T>(dir: string | null, fn: () => T): Promise<T> {
  if (!dir) return fn();
  const lock = join(dir, REFRESH_LOCK);
  const end = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      if (Date.now() >= end) throw refuse("refresh_locked", `${dir}: claude обновляет вход дольше ${LOCK_WAIT_MS / 1000} с`);
      await sleep(100);
    }
  }
  try {
    return fn();
  } finally {
    rmdirSync(lock);
  }
}

export function make(): Module {
  let host: Host;
  let timer: ReturnType<typeof setInterval> | null = null;
  /** процессы входа: имя → короткий claude, ждущий код */
  const logins = new Map<string, { p: Probe; state: string | null }>();

  const store = () => host.store<Accounts>();
  const all = (): Accounts => store().get() ?? {};
  const dirOf = (name: string) => join(host.dataDir, "accounts", name);
  const env = (name: string): Record<string, string> => ({ CLAUDE_CONFIG_DIR: dirOf(name) });
  const save = (name: string, fn: (a: Account | undefined) => Account | undefined) =>
    store().update((cur = {}) => {
      const next = fn(cur[name]);
      if (next) cur[name] = next;
      else delete cur[name];
      return cur;
    });
  const need = (f: Frame): [string, Account] => {
    const name = f.account;
    const a = typeof name === "string" ? all()[name] : undefined;
    if (!a) throw refuse("no_account", `аккаунта ${String(name)} на машине нет`);
    return [name as string, a];
  };

  function closeLogin(name: string): void {
    logins.get(name)?.p.close();
    logins.delete(name);
  }

  /** claude auth status с папкой аккаунта: вошёл ли. */
  async function loggedIn(name: string): Promise<boolean> {
    const r = await host.cli(["auth", "status"], { env: env(name) });
    if (r.code !== 0) return false;
    try {
      return (JSON.parse(r.out) as { loggedIn?: boolean }).loggedIn !== false;
    } catch {
      return true; // выход 0 без JSON — вошёл
    }
  }

  /** Проверка входа всех аккаунтов: пропал — login none и строка журнала. */
  async function check(): Promise<void> {
    for (const [name, a] of Object.entries(all())) {
      if (a.login === "pending") continue;
      const ok = await loggedIn(name);
      const now = sec();
      save(name, (cur) => cur && { ...cur, login: cur.login === "pending" ? "pending" : ok ? "ok" : "none", checked: now });
      if (!ok && a.login === "ok") host.log({ kind: "stop", ev: "login_lost", account: name, why: `${name}: вход пропал` });
    }
  }

  /** Наблюдение окон: каждое окно — из самого свежего источника. */
  function merge(name: string, windows: Record<string, { utilization: number; resetsAt: number }>, src: string, at: number): void {
    save(name, (a) => {
      if (!a) return a;
      const limits = { ...a.limits };
      for (const [w, v] of Object.entries(windows)) {
        if (typeof v?.utilization !== "number") continue;
        const cur = limits[w];
        if (cur && cur.at > at) continue;
        limits[w] = { utilization: v.utilization, resetsAt: v.resetsAt, at, src };
      }
      return { ...a, limits };
    });
  }

  /** Опрос лимитов коротким claude с папкой аккаунта. Не ответил — прежние окна и err. */
  async function poll(name: string): Promise<void> {
    const p = host.probe({ env: env(name) });
    try {
      const r = (await p.sdk(USAGE, { skipBehaviors: true })) as {
        subscription_type?: string | null;
        rate_limits?: Record<string, { utilization: number | null; resets_at: string | null } | null> | null;
      };
      const windows: Record<string, { utilization: number; resetsAt: number }> = {};
      for (const [w, v] of Object.entries(r.rate_limits ?? {})) {
        if (!v || typeof v.utilization !== "number") continue;
        windows[w] = { utilization: v.utilization / 100, resetsAt: v.resets_at ? Math.floor(Date.parse(v.resets_at) / 1000) : 0 };
      }
      merge(name, windows, "poll", sec());
      save(name, (cur) => {
        if (!cur) return cur;
        const { err: _e, ...rest } = cur;
        return { ...rest, ...(r.subscription_type ? { plan: r.subscription_type } : {}) };
      });
    } catch (e) {
      const why = (e as Error).message;
      save(name, (cur) => cur && { ...cur, err: why });
      host.log({ kind: "refuse", ev: "poll", account: name, why: `${name}: опрос лимитов не ответил — ${why}` });
    } finally {
      p.close();
    }
  }

  /** Запись наружу: окно, чей сброс прошёл, — 0 %. */
  function view(a: Account, now: number) {
    const limits: Record<string, Window> = {};
    for (const [w, v] of Object.entries(a.limits ?? {})) limits[w] = v.resetsAt && v.resetsAt <= now ? { ...v, utilization: 0 } : v;
    return { ...a, limits };
  }

  /** Прежний формат: вход переносился в папку слота (lent). Вернуть его домой и повесить ссылку. */
  function migrate(): void {
    for (const [name, a] of Object.entries(all()) as Array<[string, Account & { lent?: string | null; given?: string }]>) {
      if (Array.isArray(a.links)) continue;
      const links: string[] = [];
      if (a.lent) {
        const f = join(a.lent, CREDENTIALS);
        mkdirSync(dirOf(name), { recursive: true });
        if (existsSync(f)) renameSync(f, join(dirOf(name), CREDENTIALS));
        linkSlot(a.lent, dirOf(name));
        links.push(resolve(a.lent));
      }
      save(name, (cur) => {
        const { lent: _l, given: _g, ...rest } = cur as Account & { lent?: unknown; given?: unknown };
        return { ...rest, links };
      });
      host.log({ ev: "migrate", account: name, why: `${name}: вход дома${links.length ? `, ссылка ${links[0]}` : ""}` });
    }
  }

  const requests: Module["requests"] = {
    async "machine.accounts"(f) {
      const maxAge = typeof f.max_age === "number" ? f.max_age : null;
      const only = typeof f.only === "string" ? f.only : null;
      if (maxAge !== null) {
        const now = sec();
        for (const [name, a] of Object.entries(all())) {
          if (a.login !== "ok" || (only !== null && name !== only)) continue;
          const fresh = Math.max(0, ...Object.values(a.limits ?? {}).map((w) => w.at));
          if (now - fresh > maxAge) await poll(name); // один опрос за раз
        }
      }
      const now = sec();
      const accounts: Record<string, unknown> = {};
      for (const [name, a] of Object.entries(all())) accounts[name] = view(a, now);
      return { accounts };
    },

    async "machine.login"(f) {
      const name = f.account;
      if (typeof name !== "string" || !NAME.test(name)) throw refuse("bad_frame", "имя аккаунта — латиница, цифры, - и _");
      closeLogin(name); // повтор закрывает прежний процесс входа
      mkdirSync(dirOf(name), { recursive: true });
      const p = host.probe({ env: env(name) });
      logins.set(name, { p, state: null });
      let r: { manualUrl?: string };
      try {
        r = (await p.sdk("claudeAuthenticate", true)) as { manualUrl?: string };
      } catch (e) {
        closeLogin(name);
        throw refuse("login_failed", `${name}: claudeAuthenticate — ${(e as Error).message}`);
      }
      const url = r.manualUrl ?? "";
      logins.set(name, { p, state: new URL(url, "https://claude.ai").searchParams.get("state") });
      save(name, (cur) => ({ ...(cur ?? { links: [], limits: {} }), login: "pending" }));
      host.log({ ev: "login", account: name, why: `${name}: вход начат` });
      return { url };
    },

    async "machine.login_code"(f) {
      const name = f.account as string;
      const l = typeof name === "string" ? logins.get(name) : undefined;
      if (!l) throw refuse("not_started", `${String(name)}: входа нет — Host перезапускался или вход начат заново`);
      // код — секрет: только в тело вызова SDK, не в журнал и не в аргументы процессов
      const raw = String(f.code ?? "");
      const i = raw.indexOf("#");
      const code = i >= 0 ? raw.slice(0, i) : raw;
      const state = i >= 0 ? raw.slice(i + 1) : l.state;
      let r: { account?: { email?: string; subscriptionType?: string } };
      try {
        r = (await l.p.sdk("claudeOAuthCallback", code, state)) as typeof r;
      } catch (e) {
        closeLogin(name);
        save(name, (cur) => cur && { ...cur, login: "none" });
        throw refuse("bad_code", `${name}: claude не принял код — ${(e as Error).message.replaceAll(raw, "…").replaceAll(code, "…")}`);
      }
      let acc = r?.account;
      if (!acc?.email) acc = ((await l.p.sdk("accountInfo")) as typeof acc) ?? acc;
      closeLogin(name);
      const ok = all()[name] ? await loggedIn(name) : false;
      save(name, (cur) => ({
        ...(cur ?? { links: [], limits: {} }),
        login: ok ? "ok" : "none",
        checked: sec(),
        ...(acc?.email ? { email: acc.email } : {}),
        ...(acc?.subscriptionType ? { plan: acc.subscriptionType } : {}),
      }));
      host.log({ ev: "login", account: name, why: ok ? `${name}: вошёл` : `${name}: claude принял код, но auth status — не вошёл` });
      return { email: acc?.email ?? null, plan: acc?.subscriptionType ?? null };
    },

    "machine.account_remove"(f) {
      const [name, a] = need(f);
      if (a.links.length) throw refuse("in_slot", `${name}: стоит в ${a.links.join(", ")} — сначала его сменит slots`);
      closeLogin(name);
      // только своя папка аккаунта; claude auth logout не зовём — он чистит общие настройки
      rmSync(dirOf(name), { recursive: true, force: true });
      save(name, () => undefined);
      host.log({ ev: "account_remove", account: name, why: `${name}: папка аккаунта удалена` });
      return { wiped: true };
    },

    "account.usage"(f) {
      const [name] = need(f);
      const at = typeof f.at === "number" ? f.at : sec();
      merge(name, (f.windows ?? {}) as Record<string, { utilization: number; resetsAt: number }>, String(f.src ?? "event"), at);
      return undefined;
    },

    async "account.place"(f) {
      const dir = typeof f.dir === "string" && f.dir ? resolve(f.dir) : null;
      if (!dir) throw refuse("bad_frame", "account.place: нет dir");
      const name = typeof f.account === "string" ? f.account : null;
      if (name !== null) {
        const a = all()[name];
        if (!a) throw refuse("no_account", `аккаунта ${name} на машине нет`);
        if (a.login !== "ok" || !existsSync(join(dirOf(name), CREDENTIALS))) throw refuse("not_logged_in", `${name}: входа нет`);
      }
      const from = Object.entries(all()).find(([, x]) => x.links.includes(dir))?.[0] ?? null;
      if (from === name) return { from };
      // claude сессий слота обновляет вход в папке прежнего аккаунта — перевешиваем, пока она не занята
      await locked(from ? dirOf(from) : null, () => (name ? linkSlot(dir, dirOf(name)) : unlinkSlot(dir)));
      store().update((cur = {}) => {
        for (const [n, x] of Object.entries(cur)) cur[n] = { ...x, links: [...x.links.filter((d) => d !== dir), ...(n === name ? [dir] : [])] };
        return cur;
      });
      host.log({ ev: "place", account: name, dir, from });
      return { from };
    },
  };

  return {
    requests,
    start(h) {
      host = h;
      migrate();
      // процесс входа умер вместе с прежним Host
      for (const [name, a] of Object.entries(all())) if (a.login === "pending") save(name, (cur) => cur && { ...cur, login: "none" });
      timer = setInterval(() => void check().catch((e) => host.log({ kind: "refuse", ev: "check", why: (e as Error).message })), CHECK_MS);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      for (const name of [...logins.keys()]) closeLogin(name);
    },
  };
}
