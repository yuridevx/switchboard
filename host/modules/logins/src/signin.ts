// Вход по ссылке и коду своей папкой и проверка входа раз в 2 минуты. Токена модуль не видит: файлы входа пишет сам claude.
import { mkdirSync } from "node:fs";
import type { Host, Probe } from "@switchboard/host";
import { refuse } from "@switchboard/host";
import { CALL_MS, READ_MS, within } from "@switchboard/protocol";
import type { Account } from "./limits.ts";
import type { Folders } from "./links.ts";

const NAME = /^[A-Za-z0-9_-]+$/;
const CHECK_MS = 120_000;
/** Срок ссылки неизвестен: цена ошибки — новая ссылка. */
const LOGIN_WAIT_MS = 30 * 60_000;

const say = (e: unknown) => (e as Error).message;
type Started = { probe: Probe; state: string; expiry: ReturnType<typeof setTimeout> };
type Info = { email?: string; subscriptionType?: string };

/** edit — запись аккаунта; создаёт её при первом входе. */
export function signin(host: () => Host, dirs: Folders, read: () => Record<string, Account>, edit: (name: string, patch: Partial<Account>) => void) {
  const started = new Map<string, Started>();
  let timer: ReturnType<typeof setInterval>;

  function end(name: string): Started | undefined {
    const s = started.get(name);
    if (!s) return undefined;
    started.delete(name);
    clearTimeout(s.expiry);
    s.probe.close();
    return s;
  }

  /** Вошёл ли claude этой папкой; нет имени — общий вход машины. */
  const loggedIn = async (name?: string) => (await within(host().cli(["auth", "status"], { env: name ? { CLAUDE_CONFIG_DIR: dirs.accDir(name) } : {} }), `auth status не ответил за ${READ_MS / 1000} с`, READ_MS)).code === 0;

  async function check(name: string): Promise<void> {
    try {
      const ok = await loggedIn(name);
      const was = read()[name];
      if (!was || was.login === "pending") return;
      if (!ok && was.login === "ok") host().log({ kind: "stop", ev: "login_lost", why: `${name}: вход пропал` });
      edit(name, { login: ok ? "ok" : "none", checked: Date.now() });
    } catch (e) {
      host().log({ kind: "refuse", ev: "check", why: `${name}: ${say(e)}` });
    }
  }

  return {
    start() {
      for (const [name, a] of Object.entries(read())) if (a.login === "pending") edit(name, { login: "none" }); // Host перезапущен посреди входа
      timer = setInterval(() => {
        for (const name of Object.keys(read())) void check(name);
      }, CHECK_MS);
    },
    stop() {
      clearInterval(timer);
      for (const name of [...started.keys()]) end(name);
    },
    end,
    loggedIn,
    async login(name: string): Promise<{ url: string }> {
      if (!NAME.test(name)) throw refuse("bad_frame", "имя аккаунта — латиница, цифры, - и _");
      end(name);
      mkdirSync(dirs.accDir(name), { recursive: true });
      edit(name, { login: "pending" });
      const probe = host().probe({ env: { CLAUDE_CONFIG_DIR: dirs.accDir(name) } });
      try {
        const { manualUrl } = (await within(probe.sdk("claudeAuthenticate", true), `не ответил за ${CALL_MS / 1000} с`, CALL_MS)) as { manualUrl: string };
        const expiry = setTimeout(() => {
          end(name);
          edit(name, { login: "none" });
          host().log({ kind: "refuse", ev: "login", why: `${name}: срок входа вышел — кода нет за ${LOGIN_WAIT_MS / 60_000} мин` });
        }, LOGIN_WAIT_MS);
        started.set(name, { probe, state: new URL(manualUrl, "https://claude.ai").searchParams.get("state") ?? "", expiry });
        host().log({ ev: "login", why: `${name}: вход начат` });
        return { url: manualUrl };
      } catch (e) {
        probe.close();
        edit(name, { login: "none" });
        throw refuse("login_failed", `${name}: claudeAuthenticate — ${say(e)}`);
      }
    },
    async code(name: string, pasted: string): Promise<{ email?: string; plan?: string }> {
      const s = started.get(name);
      if (!s) throw refuse("not_started", `${name}: входа нет — Host перезапускался, вход начат заново или срок вышел`);
      const [code, state = s.state] = pasted.trim().split("#");
      const late = `не ответил за ${CALL_MS / 1000} с`;
      try {
        const answer = (await within(s.probe.sdk("claudeOAuthCallback", code, state), late, CALL_MS)) as { account?: Info };
        let info = answer.account ?? {};
        if (!info.email) {
          // код принят: почта и тариф придут со следующей проверкой
          info = ((await within(s.probe.sdk("accountInfo"), late, CALL_MS).catch((e) => void host().log({ kind: "refuse", ev: "login", why: `${name}: accountInfo — ${say(e)}` }))) as Info | undefined) ?? {};
        }
        end(name);
        const ok = await loggedIn(name);
        host().log({ ev: "login", why: ok ? `${name}: вошёл` : `${name}: claude принял код, но auth status — не вошёл` });
        edit(name, { login: ok ? "ok" : "none", email: info.email, plan: info.subscriptionType, checked: Date.now() });
        return { email: info.email, plan: info.subscriptionType };
      } catch (e) {
        end(name);
        edit(name, { login: "none" });
        throw refuse("bad_code", `${name}: claude не принял код — ${say(e)}`);
      }
    },
  };
}
