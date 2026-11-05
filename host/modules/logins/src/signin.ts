// Вход по ссылке и коду в пустой папке и сверка входа раз в 2 минуты. Кто вошёл, говорит только claude auth status: почта самого токена, не запись конфига (опыт 5 нояб.).
// Токена модуль не видит: файлы входа пишет сам claude.
import { mkdirSync } from "node:fs";
import type { Host, Probe } from "@switchboard/host";
import { refuse } from "@switchboard/host";
import { CALL_MS, READ_MS, within } from "@switchboard/protocol";
import type { Account } from "./limits.ts";
import { envOf, type Folders } from "./links.ts";

const CHECK_MS = 120_000;
/** Срок ссылки неизвестен: цена ошибки — новая ссылка. */
const LOGIN_WAIT_MS = 30 * 60_000;

const say = (e: unknown) => (e as Error).message;
type Started = { probe: Probe; state: string; expiry: ReturnType<typeof setTimeout> };
/** Что сказал claude auth status. Кода 0 без почты недостаточно, чтобы менять состояние. */
type Status = { code: number; email?: string; plan?: string; expires?: number };
export type SignedIn = Pick<Account, "plan" | "expires">;

function parseStatus(code: number, out: string): Status {
  try {
    const j = JSON.parse(out) as { email?: string | null; subscriptionType?: string | null; loginExpiresAt?: string | null };
    return {
      code,
      ...(j.email ? { email: j.email.toLowerCase() } : {}),
      ...(j.subscriptionType ? { plan: j.subscriptionType } : {}),
      ...(j.loginExpiresAt ? { expires: Math.floor(Date.parse(j.loginExpiresAt) / 1000) } : {}),
    };
  } catch {
    return { code };
  }
}

type Hooks = {
  read(): Record<string, Account>;
  edit(email: string, patch: Partial<Account>): void;
  /** Вход перестал быть годным: слоты, где стоит этот аккаунт, переходят на следующего. */
  lost(email: string): void;
  /** Почта известна: положить вход на место и завести запись. */
  landed(email: string, info: SignedIn): Promise<void>;
};

export function signin(host: () => Host, dirs: Folders, hooks: Hooks) {
  let started: Started | null = null;
  let timer: ReturnType<typeof setInterval>;

  /** Закрыть идущий вход; папка .new стёрта. */
  function end(): void {
    if (started) {
      clearTimeout(started.expiry);
      started.probe.close();
      started = null;
    }
    try {
      dirs.clearNew();
    } catch (e) {
      // процесс ещё держит папку: следующий вход или старт сотрёт её снова
      host().log({ kind: "refuse", ev: "login", why: `.new не стёрта — ${say(e)}` });
    }
  }

  async function status(dir: string): Promise<Status> {
    const r = await within(host().cli(["auth", "status"], { env: envOf(dir) }), `auth status не ответил за ${READ_MS / 1000} с`, READ_MS);
    return parseStatus(r.code ?? 1, r.out);
  }

  /** Почта не совпала или входа нет — «нет входа» и подмена. Команда не ответила или почты нет — состояние прежнее: обрыв сети слот не меняет. */
  async function check(email: string): Promise<void> {
    try {
      const s = await status(dirs.accDir(email));
      const was = hooks.read()[email];
      if (!was) return;
      if (s.code === 0 && !s.email) {
        host().log({ kind: "refuse", ev: "check", why: `${email}: auth status без почты` });
        return;
      }
      if (s.code === 0 && s.email === email) {
        hooks.edit(email, { login: "ok", ...(s.plan ? { plan: s.plan } : {}), ...(s.expires ? { expires: s.expires } : {}) });
        return;
      }
      hooks.edit(email, { login: "none" });
      if (was.login !== "ok") return;
      if (s.email) host().log({ kind: "stop", ev: "login_foreign", why: `${email}: в папке вход ${s.email}` });
      else host().log({ kind: "stop", ev: "login_lost", why: `${email}: вход пропал` });
      hooks.lost(email);
    } catch (e) {
      host().log({ kind: "refuse", ev: "check", why: `${email}: ${say(e)}` });
    }
  }

  return {
    start() {
      end(); // процесс входа умер вместе с прежним Host
      timer = setInterval(() => {
        for (const email of Object.keys(hooks.read())) void check(email);
      }, CHECK_MS);
    },
    stop() {
      clearInterval(timer);
      end();
    },
    /** На машине один вход за раз: новый отменяет начатый. */
    async login(): Promise<{ url: string }> {
      end();
      mkdirSync(dirs.newDir, { recursive: true });
      const probe = host().probe({ env: envOf(dirs.newDir) });
      try {
        const { manualUrl } = (await within(probe.sdk("claudeAuthenticate", true), `не ответил за ${CALL_MS / 1000} с`, CALL_MS)) as { manualUrl: string };
        const expiry = setTimeout(() => {
          end();
          host().log({ kind: "refuse", ev: "login", why: `срок входа вышел — кода нет за ${LOGIN_WAIT_MS / 60_000} мин` });
        }, LOGIN_WAIT_MS);
        started = { probe, state: new URL(manualUrl, "https://claude.ai").searchParams.get("state") ?? "", expiry };
        host().log({ ev: "login", why: "вход начат" });
        return { url: manualUrl };
      } catch (e) {
        probe.close();
        end();
        throw refuse("login_failed", `claudeAuthenticate — ${say(e)}`);
      }
    },
    async code(pasted: string): Promise<{ email: string; plan?: string }> {
      const s = started;
      if (!s) throw refuse("not_started", "входа нет — Host перезапускался, вход начат заново или срок вышел");
      const [code, state = s.state] = pasted.trim().split("#");
      try {
        await within(s.probe.sdk("claudeOAuthCallback", code, state), `не ответил за ${CALL_MS / 1000} с`, CALL_MS);
      } catch (e) {
        end();
        throw refuse("bad_code", `claude не принял код — ${say(e).replaceAll(pasted, "…").replaceAll(code, "…")}`);
      }
      try {
        const who = await status(dirs.newDir);
        if (who.code !== 0 || !who.email) throw refuse("login_failed", "claude принял код, но auth status не назвал почту");
        const info = { ...(who.plan ? { plan: who.plan } : {}), ...(who.expires ? { expires: who.expires } : {}) };
        await hooks.landed(who.email, info);
        host().log({ ev: "login", why: `${who.email}: вошёл` });
        return { email: who.email, ...(who.plan ? { plan: who.plan } : {}) };
      } catch (e) {
        host().log({ kind: "refuse", ev: "login", why: say(e) });
        throw e;
      } finally {
        end();
      }
    },
  };
}
