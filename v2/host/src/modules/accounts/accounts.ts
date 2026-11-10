// Аккаунты машины: входы Claude с лимитами, очередь выбора auto и ключи флота. Имя аккаунта — его почта.
// Очередь auto — ссылка на диске на папку аккаунта: кто в ней сейчас, знает только ссылка. Все её изменения идут одной очередью.
// Значение ключа флота — только в памяти; настройки ключа — в записи сессии: подъём читает их без связи.
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { keysList, keysValue, ledgerAdd, READ_MS, Refusal, within, type Account as AccountOut } from "@sb/protocol";
import type { HostApi, Module, SessionApi } from "../../core/contract.ts";
import type { Account } from "./limits.ts";
import { nextUp, over, shown, stale, usable, usableAt } from "./limits.ts";
import { envOf, folders, type Folders } from "./links.ts";
import { signin, type SignedIn } from "./signin.ts";

type Book = { accounts: Record<string, Account>; order: string[] };
/** Настройки ключа флота без значения: models — имена моделей claude → модели провайдера; window — окно контекста, токены;
 *  env — окружение сессии; settings — настройки Claude. */
type KeyConfig = { provider: string; base?: string; model?: string; models?: Record<string, string>; window?: number; env?: Record<string, string>; settings?: Record<string, unknown> };

/** Окружение сессии на ключе флота: alias моделей и окно — родными переменными Claude; сам ключ ставит прокси. */
export const keyEnv = (c: KeyConfig): Record<string, string> => ({
  ...c.env,
  ...Object.fromEntries(Object.entries(c.models ?? {}).filter(([, to]) => to).map(([name, to]) => [`ANTHROPIC_DEFAULT_${name.toUpperCase()}_MODEL`, to])),
  ...(c.window ? { CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(c.window) } : {}),
  ANTHROPIC_API_KEY: KEY_WORD,
});
/** Запись сессии: аккаунт, на котором оборвался ход, и настройки ключа, с которыми она стартует. */
type Seat = { cut?: string; key?: KeyConfig };
/** Куда идёт вызов модели сессии: вход Claude как есть — Anthropic; ключ флота — адрес и значение. */
export type Route = { to: string; key?: string; provider?: string };
export type AccountsApi = { route(sessionId: string): Promise<Route>; keyRoute(name: string): Promise<Route & { env: Record<string, string> }> };

const USAGE = "usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET";
/** Имя ссылки очереди на диске. */
const AUTO = "auto";
/** Окна запасного старше этого — спросить у Claude: расход на других машинах видно только там. */
const FRESH_S = 120;
const POLL_MS = READ_MS - 2_000;
/** Один аккаунт на разных машинах: 17:59:59 и 18:00:00. */
const RESET_DRIFT_S = 2;
const CONTINUE = "Продолжай";
const WINDOW_NAMES: Record<string, string> = { five_hour: "5 ч", seven_day: "нед." };
const ANTHROPIC = "https://api.anthropic.com";
/** Слово вместо ключа в окружении сессии на ключе флота: сам ключ ставит прокси. */
const KEY_WORD = "fleet";
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const now = () => Math.floor(Date.now() / 1000);
const clock = (t: number) => new Date(t * 1000).toTimeString().slice(0, 5);
const say = (e: unknown) => (e as Error).message;
/** Что выбрано в документе: очередь, вход по почте или ключ флота по имени. */
const kindOf = (account: string | undefined): "auto" | "claude" | "key" => (!account || account === AUTO ? "auto" : EMAIL.test(account) ? "claude" : "key");

export function make(): Module {
  let host: HostApi;
  let dirs: Folders;
  /** Значения ключей флота — только в памяти: имя → значение. */
  const values = new Map<string, string>();
  /** Папка входа сессий на ключах флота: пустая, чужой вход в неё не попадает. */
  let keyHome: string;
  let stopping = false;
  let wake: ReturnType<typeof setTimeout> | undefined;
  let tail: Promise<unknown> = Promise.resolve();
  const polls = new Set<{ close(): void }>();
  /** идущие опросы лимитов: один на аккаунт, второй спросивший ждёт тот же */
  const polling = new Map<string, Promise<void>>();
  let auth: ReturnType<typeof signin>;

  const shelf = () => host.store<Book>();
  const book = (): Book => shelf().get() ?? { accounts: {}, order: [] };
  const write = (fn: (b: Book) => void) => void shelf().update((b = { accounts: {}, order: [] }) => (fn(b), b));
  const seatOf = (s: SessionApi) => s.store<Seat>();
  const current = () => dirs.inSlot(AUTO);
  /** Сессии очереди auto. */
  const queued = () => host.sessions().filter((s) => kindOf(s.spec.account) === "auto");

  /** Изменения очереди — по одному. */
  function serial<T>(work: () => T | Promise<T>): Promise<T> {
    const run = tail.then(() => {
      if (stopping) throw new Refusal("shutting_down", "Host останавливается, аккаунт не сменён — повторите запрос");
      return work();
    });
    tail = run.catch(() => {});
    return run;
  }
  /** Работа без спроса: отказ уже в журнале у того, кто отказал. */
  const background = (work: () => Promise<void>) =>
    void serial(work).catch((e) => {
      if (!(e instanceof Refusal)) host.log.error("accounts", { why: say(e) });
    });

  /** Очередь ждёт сброса: в ней аккаунт у порога и запаса нет. */
  function waitAt(): number | null {
    const { accounts, order } = book();
    const cur = current();
    const t = now();
    if (!cur || !accounts[cur] || usable(accounts[cur], t) || nextUp(order, accounts, t, cur)) return null;
    const times = order.filter((n) => accounts[n]?.login === "ok").map((n) => usableAt(accounts[n]!, t)).filter(Boolean);
    return times.length ? Math.min(...times) : null;
  }

  /** Побудка на ближайший сброс. */
  function plan(): void {
    clearTimeout(wake);
    wake = undefined;
    const at = stopping ? null : waitAt();
    if (!at) return;
    wake = setTimeout(() => background(reset), Math.max(0, at * 1000 - Date.now()));
    wake.unref();
  }

  /** Единственная смена аккаунта очереди: ссылка, строки сессий, журнал машины и флота. */
  async function put(to: string, why: string): Promise<void> {
    const from = current();
    await dirs.place(AUTO, to);
    for (const s of queued()) s.sync();
    const text = `очередь аккаунтов: ${from ?? "—"} → ${to} · ${why}`;
    host.log.info("account_swap", { why: text });
    void host.call(ledgerAdd, { what: "account.swapped", machine: host.machine, text }).catch(() => {});
  }

  /** Сессия с оборвавшимся ходом продолжает, когда свободна; тот же аккаунт — только после его сброса. */
  function resume(s: SessionApi, sameToo = false): void {
    const seat = seatOf(s).get();
    if (!seat?.cut || s.state !== "idle" || kindOf(s.spec.account) !== "auto") return;
    if (seat.cut === current() && !sameToo) return;
    seatOf(s).update((x) => ({ ...x, cut: undefined }));
    s.input(CONTINUE);
  }

  /** После смены очереди: строки, побудка, оборванные. */
  function settled(sameToo = false): void {
    for (const s of queued()) {
      s.sync();
      resume(s, sameToo);
    }
    plan();
  }

  /** Опрос лимитов аккаунта: одновременно — один. */
  function poll(name: string): Promise<void> {
    const going = polling.get(name);
    if (going) return going;
    const p = pollOnce(name).finally(() => polling.delete(name));
    polling.set(name, p);
    return p;
  }

  async function pollOnce(name: string): Promise<void> {
    if (stopping) return;
    const probe = host.probe({ env: envOf(dirs.accDir(name)) });
    polls.add(probe);
    try {
      const u = (await within(probe.sdk(USAGE, { skipBehaviors: true }), POLL_MS, `не ответил за ${POLL_MS / 1000} с`)) as { rate_limits?: Record<string, { utilization?: number | null; resets_at?: string | null } | null> | null };
      const at = now();
      write((b) => {
        const a = b.accounts[name];
        if (!a) return;
        // неактивное окно приходит null, а в extra_usage utilization — null
        for (const [w, v] of Object.entries(u?.rate_limits ?? {})) if (typeof v?.utilization === "number") a.limits[w] = { utilization: v.utilization / 100, resetsAt: v.resets_at ? Math.floor(Date.parse(v.resets_at) / 1000) : 0, at };
      });
    } catch (e) {
      host.log.warn("poll", { why: `${name}: опрос лимитов — ${say(e)}` });
    } finally {
      polls.delete(probe);
      probe.close();
    }
  }

  /** Кого поставить в очередь: по порядку, окна свежие у Claude; у порога — следующий. */
  async function reserve(from: string | null): Promise<string | null> {
    for (const name of book().order) {
      if (name === from || !usable(book().accounts[name], now())) continue;
      if (stale(book().accounts[name]!, FRESH_S, now())) await poll(name);
      if (usable(book().accounts[name], now())) return name;
    }
    return null;
  }

  /** Подмена без человека: порог или отказ модели; очередь успела смениться — ничего. */
  function swapFrom(from: string, why: string): void {
    background(async () => {
      if (current() !== from) return;
      const to = await reserve(from);
      if (!to) {
        const w = waitAt();
        host.log.info("account_wait", { why: `все аккаунты очереди у порога — жду сброса${w ? ` ${clock(w)}` : ""}` });
        return settled();
      }
      try {
        await put(to, why);
      } finally {
        settled();
      }
    });
  }

  /** Вход перестал быть годным: очередь идёт на следующего. */
  function lost(email: string): void {
    if (current() === email) swapFrom(email, "вход пропал");
    plan();
  }

  /** Почта нового входа известна: файл на место, запись; первый вход на машине встаёт в очередь. */
  function landed(email: string, info: SignedIn): Promise<void> {
    return serial(async () => {
      await dirs.settle(email);
      write((b) => {
        b.accounts[email] = { ...(b.accounts[email] ?? { limits: {} }), ...info, login: "ok" };
        if (!b.order.includes(email) && !b.order.length) b.order.push(email);
      });
      if (!current()) await put(email, "первый вход");
      plan();
      host.log.info("account_login", { why: `${email}: вход` });
      void host.call(ledgerAdd, { what: "account.login", machine: host.machine, text: `вход ${email} на ${host.machine}` }).catch(() => {});
    });
  }

  /** Час сброса: аккаунт очереди снова годен или в запасе появился годный. */
  async function reset(): Promise<void> {
    const cur = current();
    if (cur && usable(book().accounts[cur], now())) {
      host.log.info("account_reset", { why: `сброс ${cur} — продолжаю` });
      return settled(true);
    }
    const to = await reserve(cur);
    if (to) {
      await put(to, "сброс");
      settled();
    } else plan();
  }

  /** Окно из сообщения сессии. Сброс совпал с окном другого аккаунта порядка — это поздний ответ прежнего. */
  function limitEvent(s: SessionApi, cur: string, auto: boolean, info: { status?: string; rateLimitType?: string; utilization?: number; resetsAt?: number }): void {
    const type = info.rateLimitType;
    if (!type) return;
    const rejected = info.status === "rejected";
    const utilization = rejected ? 1 : info.utilization;
    if (utilization === undefined) return;
    const resetsAt = info.resetsAt ?? 0;
    const { accounts, order } = book();
    const same = (n: string) => {
      const known = accounts[n]?.limits[type]?.resetsAt;
      return known !== undefined && Math.abs(known - resetsAt) <= RESET_DRIFT_S;
    };
    const owner = !auto || same(cur) ? cur : (order.find((n) => n !== cur && same(n)) ?? cur);
    const at = now();
    write((b) => {
      const a = b.accounts[owner];
      if (a && !((a.limits[type]?.at ?? 0) > at)) a.limits[type] = { utilization, resetsAt, at };
    });
    if (!auto) return;
    if (owner !== cur) {
      host.log.info("account_late", { callsign: s.callsign, why: `поздний ответ ${owner}` });
      return plan();
    }
    if (rejected) seatOf(s).update((x) => ({ ...x, cut: cur }));
    const a = book().accounts[cur];
    if (rejected) swapFrom(cur, "отказ");
    else if (a && over(a, at)) swapFrom(cur, `${WINDOW_NAMES[type] ?? type} ${Math.round(utilization * 100)} %`);
    plan();
  }

  /** Свежий ключ: значение — в память, настройки — ответом. Ключа нет — как нет такого аккаунта. */
  async function takeKey(name: string): Promise<KeyConfig> {
    try {
      const { value, ...config } = await within(host.call(keysValue, { name }), READ_MS, `ключ флота ${name}: службы не ответили за ${READ_MS / 1000} с`);
      values.set(name, value);
      return config;
    } catch (e) {
      const r = e as Refusal;
      throw r.word === "not_found" || r.word === "no_key" ? new Refusal("no_account", `${name}: такого аккаунта и ключа флота нет`) : new Refusal(r.word ?? "module_failed", `ключ флота ${name}: ${r.why ?? say(e)}`);
    }
  }

  const sessionOf = (sessionId: string) => host.sessions().find((x) => x.info.sessionId === sessionId);

  const api: AccountsApi = {
    async route(sessionId) {
      const s = sessionOf(sessionId);
      if (!s) throw new Refusal("unknown_session", `сессии ${sessionId} на ${host.machine} нет`);
      const name = s.spec.account;
      if (kindOf(name) !== "key") return { to: ANTHROPIC };
      const config = values.has(name!) ? seatOf(s).get()?.key : await takeKey(name!);
      if (config && !seatOf(s).get()?.key) seatOf(s).update((x) => ({ ...x, key: config }));
      const key = values.get(name!);
      if (!key) throw new Refusal("no_key", `${s.callsign}: ключа ${name} нет`);
      return { to: config?.base ?? ANTHROPIC, key, provider: config?.provider };
    },
    async keyRoute(name) {
      const config = await takeKey(name);
      return { to: config.base ?? ANTHROPIC, key: values.get(name)!, provider: config.provider, env: { ...keyEnv(config), ...(config.model ? { ANTHROPIC_MODEL: config.model } : {}) } };
    },
  };

  function assertLogin(email: string): void {
    const a = book().accounts[email];
    if (!a) throw new Refusal("no_account", `аккаунта ${email} на ${host.machine} нет`);
    if (a.login !== "ok") throw new Refusal("not_logged_in", `${email}: входа нет`);
  }

  async function slotSet(order: string[]): Promise<void> {
    const { accounts } = book();
    const ghost = order.find((n) => !accounts[n]);
    if (ghost) throw new Refusal("no_account", `${ghost}: такого аккаунта на машине нет`);
    if (!order.length) {
      if (queued().length) throw new Refusal("has_sessions", "на очереди есть сессии");
      await dirs.unplace(AUTO);
    } else if (!current() || !order.includes(current()!)) {
      const first = order.find((n) => accounts[n]!.login === "ok");
      if (!first) throw new Refusal("no_reserve", "в порядке нет вошедшего аккаунта");
      await put(first, "новый порядок");
    }
    write((b) => void (b.order = order));
    settled();
  }

  /** Удаление одним запросом: сначала видно, что очереди есть кого поставить, потом шаги. */
  async function accountRemove(name: string): Promise<void> {
    if (!book().accounts[name]) throw new Refusal("no_account", `аккаунта ${name} на машине нет`);
    const fixed = host.sessions().filter((s) => s.spec.account === name);
    if (fixed.length) throw new Refusal("has_sessions", `${name}: на аккаунте сессии ${fixed.map((s) => s.callsign).join(", ")}`);
    if (current() === name) {
      const to = await reserve(name);
      if (!to && queued().length) throw new Refusal("no_reserve", "в запасе нет вошедшего аккаунта ниже порога: на очереди остались бы сессии без аккаунта");
      if (to) await put(to, "удаление аккаунта");
      else await dirs.unplace(AUTO);
    }
    write((b) => void (b.order = b.order.filter((n) => n !== name)));
    settled();
    try {
      rmSync(dirs.accDir(name), { recursive: true, force: true });
    } catch (e) {
      throw new Refusal("account_dir_busy", `${name}: папка аккаунта занята — ${say(e)}`);
    }
    write((b) => void delete b.accounts[name]);
    host.log.info("account_remove", { why: `${name}: аккаунт удалён` });
  }

  /** «Сменить сейчас»: названный аккаунт или следующий годный по порядку. */
  async function slotSwap(account: string | undefined): Promise<string> {
    const cur = current();
    if (account) {
      assertLogin(account);
      if (account === cur) return account;
      if (!book().order.includes(account)) write((b) => void b.order.push(account));
      await put(account, "по запросу");
      settled();
      return account;
    }
    const to = await reserve(cur);
    if (!to) throw new Refusal("no_reserve", "в очереди нет другого вошедшего аккаунта ниже порога");
    await put(to, "по запросу");
    settled();
    return to;
  }

  /** Когда лимиты аккаунта замерены последний раз, секунды; замеров нет — 0. */
  const measured = (a: Account) => Math.max(0, ...Object.values(a.limits).map((w) => w.at ?? 0));

  function rowOf(name: string, a: Account, t: number): AccountOut {
    const { order } = book();
    const at = order.indexOf(name);
    const back = a.login === "ok" && !usable(a, t) ? usableAt(a, t) : 0;
    const sessions = host.sessions().filter((s) => s.spec.account === name || (kindOf(s.spec.account) === "auto" && current() === name)).length;
    return {
      id: name, kind: "claude", email: name, ...(a.plan ? { plan: a.plan } : {}),
      limits: Object.entries(shown(a, t).limits).map(([w, v]) => ({ name: w, used: v.utilization, ...(v.resetsAt ? { resets: v.resetsAt * 1000 } : {}), ...(v.at ? { at: v.at * 1000 } : {}) })),
      ...(measured(a) ? { at: measured(a) * 1000 } : {}), ...(a.expires ? { expires: a.expires * 1000 } : {}),
      ...(at >= 0 ? { slot: at } : {}), ok: a.login === "ok", ...(a.login === "ok" ? {} : { why: "входа нет" }), sessions,
      ...(current() === name ? { current: true } : {}), ...(back ? { wait: back * 1000 } : {}),
    };
  }

  return {
    name: "host-accounts",
    api,
    spec: {
      async account(value) {
        const name = value as string;
        const kind = kindOf(name);
        if (kind === "claude") return assertLogin(name);
        if (kind === "key") return void (await takeKey(name));
        const cur = current();
        if (!cur) throw new Refusal("not_logged_in", `на ${host.machine} нет входа Claude: войдите в аккаунт или выберите ключ флота`);
        assertLogin(cur);
      },
    },
    async applied(s, keys) {
      if (!keys.includes("account")) return;
      if (kindOf(s.spec.account) === "key") seatOf(s).set({ key: await takeKey(s.spec.account!) });
      else seatOf(s).set(undefined);
      // новый аккаунт вступает в силу с новым процессом
      if (s.state !== "stopped" && s.state !== "failed") void s.restart();
    },
    // подъём настройки ключа берёт из записи сессии и флот не спрашивает: на старте связи ещё нет
    async compose(s) {
      const name = s.spec.account;
      const kind = kindOf(name);
      if (kind === "claude") return { env: { CLAUDE_SECURESTORAGE_CONFIG_DIR: dirs.accDir(name!) } };
      if (kind === "auto") {
        if (!current()) throw new Refusal("not_logged_in", `на ${host.machine} нет входа Claude: войдите в аккаунт или выберите ключ флота`);
        return { env: { CLAUDE_SECURESTORAGE_CONFIG_DIR: dirs.slotDir(AUTO) } };
      }
      let config = seatOf(s).get()?.key;
      if (!config) {
        config = await takeKey(name!);
        seatOf(s).update((x) => ({ ...x, key: config }));
      }
      // вход пустой: плательщик молча не меняется; сам ключ ставит прокси
      // переменные и настройки ключа — как их завели на флоте: alias моделей, окно контекста
      return {
        env: { ...keyEnv(config), CLAUDE_SECURESTORAGE_CONFIG_DIR: keyHome, ...(config.model && !s.spec.model ? { ANTHROPIC_MODEL: config.model } : {}) },
        ...(config.settings && Object.keys(config.settings).length ? { defaults: { settings: config.settings } } : {}),
      };
    },
    row(s) {
      const kind = kindOf(s.spec.account);
      const account = kind === "auto" ? current() : s.spec.account;
      // очередь ждёт сброса лимита — сессия на ней стоит до этого часа
      const wait = kind === "auto" ? waitAt() : null;
      return { ...(account ? { account } : {}), ...(wait ? { wait: wait * 1000 } : {}) };
    },
    on: {
      event(s, m) {
        const kind = kindOf(s.spec.account);
        // у ключа флота нет окон и запасных: 429 — обычная ошибка хода, сессия видит её словами
        if (kind === "key") return;
        const cur = kind === "auto" ? current() : s.spec.account!;
        if (!cur) return;
        const msg = m as { type: string; error?: string; rate_limit_info?: Parameters<typeof limitEvent>[3] };
        if (msg.type === "rate_limit_event" && msg.rate_limit_info) limitEvent(s, cur, kind === "auto", msg.rate_limit_info);
        if (kind !== "auto") return;
        if (msg.type === "assistant" && msg.error === "rate_limit" && !seatOf(s).get()?.cut) seatOf(s).update((x) => ({ ...x, cut: cur }));
        const cut = seatOf(s).get()?.cut;
        // отказ без события лимита: подмена на конце хода
        if (msg.type === "result" && cut && cut === current()) swapFrom(cut, "отказ");
      },
      state(s, state) {
        if (state === "idle") resume(s);
      },
      changed(what) {
        // ключи флота сменили: значения забыты, следующий вызов возьмёт новые
        if (what === "keys") values.clear();
      },
    },
    requests: {
      async "account.list"() {
        const stale_ = Object.entries(book().accounts).filter(([, a]) => a.login === "ok" && stale(a, FRESH_S, now())).map(([n]) => n);
        await Promise.all(stale_.map((n) => poll(n)));
        const t = now();
        const accounts = Object.entries(book().accounts).map(([n, a]) => rowOf(n, a, t));
        // ключи флота: список у службы; не ответила — только входы
        const keys = await within(host.call(keysList, {}), READ_MS).then((r) => r.keys, () => []);
        for (const k of keys) accounts.push({ id: k.name, kind: "key", ok: true, sessions: host.sessions().filter((s) => s.spec.account === k.name).length, provider: k.provider, ...(k.base ? { base: k.base } : {}), ...(k.model ? { model: k.model } : {}), ...(k.models && Object.keys(k.models).length ? { models: k.models } : {}) });
        return { accounts };
      },
      async "account.login"() {
        const { url } = await auth.login();
        return { login: "login", url };
      },
      async "account.code"({ code }: { code: string }) {
        const { email } = await auth.code(code);
        return { account: rowOf(email, book().accounts[email]!, now()) };
      },
      async "account.remove"({ account }: { account: string }) {
        await serial(() => accountRemove(account));
        return {};
      },
      async "slot.set"({ order }: { order: string[] }) {
        await serial(() => slotSet(order));
        return {};
      },
      async "slot.swap"({ account }: { account?: string }) {
        return { account: await serial(() => slotSwap(account)) };
      },
    },
    start(h) {
      host = h;
      dirs = folders(h.dataDir);
      keyHome = join(h.dataDir, "fleetkeys");
      mkdirSync(keyHome, { recursive: true });
      auth = signin(() => host, dirs, {
        read: () => book().accounts,
        edit(email, patch) {
          write((b) => void (b.accounts[email] = { ...b.accounts[email]!, ...patch }));
          plan();
        },
        lost,
        landed,
      });
      auth.start();
      plan();
    },
    async stop() {
      stopping = true;
      clearTimeout(wake);
      auth.stop();
      for (const p of polls) p.close();
      await tail;
    },
  };
}
