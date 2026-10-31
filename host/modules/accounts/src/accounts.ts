// Модуль accounts: аккаунты Claude на машине. У каждого аккаунта своя папка Claude (CLAUDE_CONFIG_DIR):
// вход, почта, тариф. Вход аккаунта живёт ровно в одном месте — в своей папке или в слоте (lent).
// С claude говорит короткими процессами без сессии (host.probe) и командой claude auth status (host.cli).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { refuse } from "@switchboard/host";
import type { Frame, Host, Module, Probe } from "@switchboard/host";

/** Окно лимита: доля 0…1, час сброса и откуда значение (event — поток слота, poll — свой опрос, иначе имя машины). */
export type Window = { utilization: number; resetsAt: number; at: number; src: string };

/** Запись аккаунта в хранилище. given — отпечаток входа, выданного в слот: по нему видно, обновил ли claude токен. */
export type Account = {
  login: "ok" | "none" | "pending";
  lent: string | null;
  email?: string;
  plan?: string;
  checked?: number;
  limits: Record<string, Window>;
  err?: string;
  given?: string;
};

export type Accounts = Record<string, Account>;

/** Файл входа claude в папке Claude (или в CLAUDE_SECURESTORAGE_CONFIG_DIR). */
export const CREDENTIALS = ".credentials.json";
const USAGE = "usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET";
const NAME = /^[A-Za-z0-9_-]+$/;
/** Проверка входа — раз в 2 мин, как в claude-fleet. */
export const CHECK_MS = 120_000;

export const switchboardHome = () => process.env.SWITCHBOARD_HOME ?? join(homedir(), ".switchboard");
const sec = () => Math.floor(Date.now() / 1000);
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** Записать файл целиком: временный рядом и rename — в папке всегда целый вход. */
function put(file: string, data: Buffer): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, file);
}

export function make(): Module {
  let host: Host;
  let timer: ReturnType<typeof setInterval> | null = null;
  /** процессы входа: имя → короткий claude, ждущий код */
  const logins = new Map<string, { p: Probe; state: string | null }>();

  const store = () => host.store<Accounts>();
  const all = (): Accounts => store().get() ?? {};
  const dirOf = (name: string) => join(switchboardHome(), "accounts", name);
  /** Где сейчас лежит вход аккаунта. */
  const fileOf = (name: string, a: Account) => join(a.lent ?? dirOf(name), CREDENTIALS);
  const env = (name: string, a?: Account): Record<string, string> => ({
    CLAUDE_CONFIG_DIR: dirOf(name),
    ...(a?.lent ? { CLAUDE_SECURESTORAGE_CONFIG_DIR: a.lent } : {}),
  });
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
  async function loggedIn(name: string, a: Account): Promise<boolean> {
    const r = await host.cli(["auth", "status"], { env: env(name, a) });
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
      const ok = await loggedIn(name, a);
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
  async function poll(name: string, a: Account): Promise<void> {
    const p = host.probe({ env: env(name, a) });
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

  /** Запись наружу: окно, чей сброс прошёл, — 0 %. given — своё, наружу не идёт. */
  function view(a: Account, now: number) {
    const { given: _g, ...rest } = a;
    const limits: Record<string, Window> = {};
    for (const [w, v] of Object.entries(a.limits ?? {})) limits[w] = v.resetsAt && v.resetsAt <= now ? { ...v, utilization: 0 } : v;
    return { ...rest, limits };
  }

  const requests: Module["requests"] = {
    async "machine.accounts"(f) {
      const maxAge = typeof f.max_age === "number" ? f.max_age : null;
      if (maxAge !== null) {
        const now = sec();
        for (const [name, a] of Object.entries(all())) {
          if (a.login !== "ok") continue;
          const fresh = Math.max(0, ...Object.values(a.limits ?? {}).map((w) => w.at));
          if (now - fresh > maxAge) await poll(name, a); // один опрос за раз
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
      const a = all()[name];
      const p = host.probe({ env: env(name, a) });
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
      save(name, (cur) => ({ ...(cur ?? { lent: null, limits: {} }), login: "pending" }));
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
      const a = all()[name];
      const ok = a ? await loggedIn(name, a) : false;
      const given = a?.lent && existsSync(join(a.lent, CREDENTIALS)) ? sha(readFileSync(join(a.lent, CREDENTIALS))) : undefined;
      save(name, (cur) => ({
        ...(cur ?? { lent: null, limits: {} }),
        login: ok ? "ok" : "none",
        checked: sec(),
        ...(acc?.email ? { email: acc.email } : {}),
        ...(acc?.subscriptionType ? { plan: acc.subscriptionType } : {}),
        ...(given ? { given } : {}),
      }));
      host.log({ ev: "login", account: name, why: ok ? `${name}: вошёл` : `${name}: claude принял код, но auth status — не вошёл` });
      return { email: acc?.email ?? null, plan: acc?.subscriptionType ?? null };
    },

    "machine.account_remove"(f) {
      const [name, a] = need(f);
      if (a.lent) throw refuse("in_slot", `${name}: вход в ${a.lent} — сначала его сменит slots`);
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

    "account.place"(f) {
      const [name, a] = need(f);
      if (a.login !== "ok") throw refuse("not_logged_in", `${name}: входа нет`);
      const target = typeof f.dir === "string" ? resolve(f.dir) : null;
      if (target === (a.lent ?? null)) return { refreshed: false };
      if (target && a.lent) throw refuse("in_slot", `${name}: вход уже в ${a.lent}`);
      const src = fileOf(name, a);
      if (!existsSync(src)) throw refuse("not_logged_in", `${name}: файла входа нет в ${src}`);

      if (target === null) {
        // вход домой — переносом: в слоте он не остаётся
        const data = readFileSync(src);
        const refreshed = !!a.given && sha(data) !== a.given;
        put(join(dirOf(name), CREDENTIALS), data);
        unlinkSync(src);
        save(name, (cur) => cur && { ...cur, lent: null, given: undefined });
        if (refreshed) host.log({ ev: "refreshed", account: name, why: `${name}: claude обновил вход в слоте` });
        return { refreshed };
      }

      const result: { returned?: string; refreshed: boolean } = { refreshed: false };
      const prev = Object.entries(all()).find(([, x]) => x.lent && resolve(x.lent) === target);
      const slotFile = join(target, CREDENTIALS);
      if (prev) {
        const [pn, pa] = prev;
        if (existsSync(slotFile)) {
          // прежний вход — копией своему аккаунту: claude мог обновить его токен
          const data = readFileSync(slotFile);
          result.refreshed = !!pa.given && sha(data) !== pa.given;
          mkdirSync(dirOf(pn), { recursive: true });
          put(join(dirOf(pn), CREDENTIALS), data);
        }
        save(pn, (cur) => cur && { ...cur, lent: null, given: undefined });
        result.returned = pn;
        if (result.refreshed) host.log({ ev: "refreshed", account: pn, why: `${pn}: claude обновил вход в слоте` });
      }
      const data = readFileSync(src);
      mkdirSync(target, { recursive: true });
      put(slotFile, data);
      unlinkSync(src);
      save(name, (cur) => cur && { ...cur, lent: target, given: sha(data) });
      host.log({ ev: "place", account: name, dir: target, ...(result.returned ? { returned: result.returned } : {}) });
      return result;
    },
  };

  return {
    requests,
    start(h) {
      host = h;
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

