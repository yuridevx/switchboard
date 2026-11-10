// Вход по ссылке и коду в пустой папке и проверка входов. Токена модуль не видит: файлы входа пишет сам claude.
// Есть ли вход, говорит claude auth status. Чей он — только пустая папка конфига: запущенный в ней Claude спрашивает сервер по токену и пишет почту в .claude.json.
// auth status и accountInfo с заполненным конфигом отвечают почтой из конфига, а не токена; accountInfo в пустом может остаться без почты (опыты 5 нояб.).
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CALL_MS, READ_MS, Refusal, within } from "@sb/protocol";
import type { HostApi } from "../../core/contract.ts";
import type { Account } from "./limits.ts";
import { envOf, type Folders } from "./links.ts";

const CHECK_MS = 120_000;
/** Сколько ждать почту в пустом конфиге: замер — около секунды. Не дождались — состояние прежнее. */
const OWNER_WAIT_MS = 8_000;
const OWNER_STEP_MS = 100;
/** Срок ссылки неизвестен: цена ошибки — новая ссылка. */
const LOGIN_WAIT_MS = 30 * 60_000;

const say = (e: unknown) => (e as Error).message;
type Host = HostApi;
type Probe = ReturnType<HostApi["probe"]>;
type Started = { probe: Probe; state: string; expiry: ReturnType<typeof setTimeout> };
type Status = { code: number; plan?: string; expires?: number };
export type SignedIn = Pick<Account, "plan" | "expires">;

function parseStatus(code: number, out: string): Status {
  try {
    const j = JSON.parse(out) as { subscriptionType?: string | null; loginExpiresAt?: string | null };
    return { code, ...(j.subscriptionType ? { plan: j.subscriptionType } : {}), ...(j.loginExpiresAt ? { expires: Math.floor(Date.parse(j.loginExpiresAt) / 1000) } : {}) };
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
  let timer: unknown;
  /** Чей токен проверяется за такт: один аккаунт, чтобы не поднимать процесс на каждый. */
  let turn = 0;
  let checks = 0;
  let asking: Probe | null = null;

  function clear(what: string, wipe: () => void): void {
    try {
      wipe();
    } catch (e) {
      // процесс ещё держит папку: следующий раз она сотрётся
      host().log.warn("login", { why: `${what} не стёрта — ${say(e)}` });
    }
  }

  /** Закрыть идущий вход; папка .new стёрта. */
  function end(): void {
    if (started) {
      clearTimeout(started.expiry);
      started.probe.close();
      started = null;
    }
    clear(".new", dirs.clearNew);
  }

  /** Почта, которую Claude записал в конфиг папки по ответу сервера. */
  async function ownerIn(dir: string): Promise<string | null> {
    const end = Date.now() + OWNER_WAIT_MS;
    for (;;) {
      try {
        const email = (JSON.parse(readFileSync(join(dir, ".claude.json"), "utf8")) as { oauthAccount?: { emailAddress?: string } }).oauthAccount?.emailAddress;
        if (email) return email.toLowerCase();
      } catch {
        // файла ещё нет или Claude его пишет
      }
      if (Date.now() >= end) return null;
      await new Promise((r) => setTimeout(r, OWNER_STEP_MS));
    }
  }

  async function status(dir: string): Promise<Status> {
    const r = await within(host().cli(["auth", "status"], { env: envOf(dir) }), READ_MS, `auth status не ответил за ${READ_MS / 1000} с`);
    return parseStatus(r.code ?? 1, r.out);
  }

  /** Есть ли вход. Заново годным аккаунт делает только проверка владельца или новый вход. Команда не ответила — состояние прежнее. */
  async function check(email: string): Promise<void> {
    try {
      const s = await status(dirs.accDir(email));
      const was = hooks.read()[email];
      if (!was) return;
      if (s.code === 0) {
        hooks.edit(email, { ...(s.plan ? { plan: s.plan } : {}), ...(s.expires ? { expires: s.expires } : {}) });
        return;
      }
      hooks.edit(email, { login: "none" });
      if (was.login !== "ok") return;
      host().log.error("login_lost", { why: `${email}: вход пропал` });
      hooks.lost(email);
    } catch (e) {
      host().log.warn("check", { why: `${email}: ${say(e)}` });
    }
  }

  /** Чей токен в папке: сверка с её именем. Чужая почта — «нет входа» и подмена. Сервер не ответил или почты нет — состояние прежнее: обрыв сети слот не меняет. */
  async function checkOwner(email: string): Promise<void> {
    clear(".who", dirs.clearWho);
    const empty = dirs.whoDir(++checks);
    mkdirSync(empty, { recursive: true });
    const probe = host().probe({ env: { CLAUDE_CONFIG_DIR: empty, CLAUDE_SECURESTORAGE_CONFIG_DIR: dirs.accDir(email) } });
    asking = probe;
    try {
      // вызов дожидается запуска процесса; почта — в конфиге
      await within(probe.sdk("accountInfo"), CALL_MS, `accountInfo не ответил за ${CALL_MS / 1000} с`);
      const owner = await ownerIn(empty);
      const was = hooks.read()[email];
      if (!was) return;
      if (!owner) {
        host().log.warn("check", { why: `${email}: сервер не назвал почту за ${OWNER_WAIT_MS / 1000} с` });
      } else if (owner === email) {
        if (was.login !== "ok") hooks.edit(email, { login: "ok" });
      } else {
        hooks.edit(email, { login: "none" });
        if (was.login === "ok") {
          host().log.error("login_foreign", { why: `${email}: в папке вход ${owner}` });
          hooks.lost(email);
        }
      }
    } catch (e) {
      host().log.warn("check", { why: `${email}: ${say(e)}` });
    } finally {
      asking = null;
      probe.close();
    }
  }

  return {
    start() {
      end(); // процесс входа умер вместе с прежним Host
      clear(".who", dirs.clearWho);
      // такт проверки входов — по часам ядра
      const beat = () => {
        timer = host().clock.setTimeout(() => {
          const names = Object.keys(hooks.read());
          for (const email of names) void check(email);
          if (names.length && !asking) void checkOwner(names[turn++ % names.length]!);
          beat();
        }, CHECK_MS);
      };
      beat();
    },
    stop() {
      host().clock.clearTimeout(timer);
      asking?.close();
      end();
      clear(".who", dirs.clearWho);
    },
    /** На машине один вход за раз: новый отменяет начатый. */
    async login(): Promise<{ url: string }> {
      end();
      mkdirSync(dirs.newDir, { recursive: true });
      const probe = host().probe({ env: envOf(dirs.newDir) });
      try {
        const { manualUrl } = (await within(probe.sdk("claudeAuthenticate", true), CALL_MS, `не ответил за ${CALL_MS / 1000} с`)) as { manualUrl: string };
        const expiry = setTimeout(() => {
          end();
          host().log.warn("login", { why: `срок входа вышел — кода нет за ${LOGIN_WAIT_MS / 60_000} мин` });
        }, LOGIN_WAIT_MS);
        started = { probe, state: new URL(manualUrl, "https://claude.ai").searchParams.get("state") ?? "", expiry };
        host().log.info("login", { why: "вход начат" });
        return { url: manualUrl };
      } catch (e) {
        probe.close();
        end();
        throw new Refusal("login_failed", `claudeAuthenticate — ${say(e)}`);
      }
    },
    async code(pasted: string): Promise<{ email: string; plan?: string }> {
      const s = started;
      if (!s) throw new Refusal("not_started", "входа нет — Host перезапускался, вход начат заново или срок вышел");
      const [code = "", state = s.state] = pasted.trim().split("#");
      try {
        await within(s.probe.sdk("claudeOAuthCallback", code, state), CALL_MS, `не ответил за ${CALL_MS / 1000} с`);
      } catch (e) {
        end();
        throw new Refusal("bad_code", `claude не принял код — ${say(e).replaceAll(pasted, "…").replaceAll(code, "…")}`);
      }
      try {
        const email = await ownerIn(dirs.newDir);
        if (!email) throw new Refusal("login_failed", "claude принял код, но не назвал почту");
        const about = await status(dirs.newDir);
        const signed = { ...(about.plan ? { plan: about.plan } : {}), ...(about.expires ? { expires: about.expires } : {}) };
        await hooks.landed(email, signed);
        host().log.info("login", { why: `${email}: вошёл` });
        return { email, ...(about.plan ? { plan: about.plan } : {}) };
      } catch (e) {
        host().log.warn("login", { why: say(e) });
        throw e;
      } finally {
        end();
      }
    },
  };
}
