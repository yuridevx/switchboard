// Аккаунты машины: входы Claude с лимитами, именованные очереди аккаунтов и ключи флота. Имя аккаунта — его почта.
// Очередь — порядок аккаунтов в записи и ссылка на диске на папку того, кто стоит сейчас: кто в ней, знает только ссылка.
// Сессия стоит в очереди или на ключе флота (поле slot её документа). Все изменения всех очередей машины идут одной линией.
// Значение ключа флота — только в памяти; настройки ключа — в записи сессии: подъём читает их без связи.
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { keysList, keysValue, ledgerAdd, READ_MS, Refusal, within, type Account as AccountOut, type Slot as SlotOut } from "@sb/protocol";
import type { HostApi, Module, SessionApi } from "../../core/contract.ts";
import type { Account, SlotModel } from "./limits.ts";
import { DEFAULT_MODEL, fits, nextUp, over, shown, stale, usable, usableAt, watched } from "./limits.ts";
import { envOf, folders, type Folders } from "./links.ts";
import { signin, type SignedIn } from "./signin.ts";

/** slots — очереди: имя → порядок аккаунтов; очередь есть, пока в ней есть аккаунт. models — вид очереди; не назван — fable. */
type Book = { accounts: Record<string, Account>; slots: Record<string, string[]>; models?: Record<string, SlotModel> };
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
/** Очередь, которую заводит первый вход на машине без очередей. */
const MAIN = "main";
/** Имя очереди — оно же имя ссылки на диске. */
const SLOT_NAME = /^[a-z0-9][a-z0-9_-]*$/;
/** Окна запасного старше этого — спросить у Claude: расход на других машинах видно только там. */
const FRESH_S = 120;
const POLL_MS = READ_MS - 2_000;
/** Один аккаунт на разных машинах: 17:59:59 и 18:00:00. */
const RESET_DRIFT_S = 2;
const CONTINUE = "Продолжай";
const WINDOW_NAMES: Record<string, string> = { five_hour: "5 ч", seven_day: "нед.", seven_day_overage_included: "Fable" };
const ANTHROPIC = "https://api.anthropic.com";
/** Слово вместо ключа в окружении сессии на ключе флота: сам ключ ставит прокси. */
const KEY_WORD = "fleet";
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const now = () => Math.floor(Date.now() / 1000);
const clock = (t: number) => new Date(t * 1000).toTimeString().slice(0, 5);
const say = (e: unknown) => (e as Error).message;

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
  /** сессии, чей отказ в этом ходе назвал окно, за которым их очередь не следит: аккаунт из-за него не меняется */
  const foreign = new Set<string>();
  let auth: ReturnType<typeof signin>;

  const shelf = () => host.store<Book>();
  const book = (): Book => shelf().get() ?? { accounts: {}, slots: {} };
  const write = (fn: (b: Book) => void) => void shelf().update((b = { accounts: {}, slots: {} }) => (fn(b), b));
  const seatOf = (s: SessionApi) => s.store<Seat>();
  const slotNames = () => Object.keys(book().slots);
  /** Вид очереди: какие модели идут в ней и за каким лимитом она следит. */
  const modelOf = (slot: string): SlotModel => book().models?.[slot] ?? "fable";
  /** Кто стоит в очереди сейчас. */
  const current = (slot: string) => dirs.inSlot(slot);
  /** Очередь сессии: имя из её документа, если такая очередь есть на машине; иначе это ключ флота. Имя сначала ищется среди очередей. */
  const slotOf = (s: SessionApi): string | null => (s.spec.slot && book().slots[s.spec.slot] ? s.spec.slot : null);
  /** Сессии очереди. */
  const queued = (slot: string) => host.sessions().filter((s) => slotOf(s) === slot);
  const slotsWord = () => (slotNames().length ? `очереди машины: ${slotNames().join(", ")}` : "очередей на машине нет");

  /** Изменения очередей — по одному, одной линией на машину: аккаунт и его лимиты у очередей общие. */
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

  /** Очередь ждёт сброса: в ней аккаунт у порога и запаса нет. Нигде не записано — считается из порядка и лимитов. */
  function waitAt(slot: string): number | null {
    const { accounts, slots } = book();
    const order = slots[slot] ?? [];
    const cur = current(slot);
    const t = now();
    const model = modelOf(slot);
    if (!cur || !accounts[cur] || usable(accounts[cur], model, t) || nextUp(order, accounts, model, t, cur)) return null;
    const times = order.filter((n) => accounts[n]?.login === "ok").map((n) => usableAt(accounts[n]!, model, t)).filter(Boolean);
    return times.length ? Math.min(...times) : null;
  }

  /** Побудка одна на машину: на ближайший сброс среди ждущих очередей. */
  function plan(): void {
    clearTimeout(wake);
    wake = undefined;
    if (stopping) return;
    const waiting = slotNames().filter((n) => waitAt(n));
    if (!waiting.length) return;
    // в час сброса каждая ждущая очередь проверяется своим шагом линии
    wake = setTimeout(() => { for (const slot of waiting) background(() => reset(slot)); }, Math.max(0, Math.min(...waiting.map((n) => waitAt(n)!)) * 1000 - Date.now()));
    wake.unref();
  }

  /** Единственная смена аккаунта очереди: ссылка, строки сессий, журнал машины и флота. */
  async function put(slot: string, to: string, why: string): Promise<void> {
    const from = current(slot);
    await dirs.place(slot, to);
    for (const s of queued(slot)) s.sync();
    const text = `очередь ${slot}: ${from ?? "—"} → ${to} · ${why}`;
    host.log.info("account_swap", { why: text });
    void host.call(ledgerAdd, { what: "account.swapped", machine: host.machine, text }).catch(() => {});
  }

  /** Сессия с оборвавшимся ходом продолжает, когда свободна; тот же аккаунт — только после его сброса. */
  function resume(s: SessionApi, sameToo = false): void {
    const seat = seatOf(s).get();
    const slot = slotOf(s);
    if (!seat?.cut || s.state !== "idle" || !slot) return;
    if (seat.cut === current(slot) && !sameToo) return;
    seatOf(s).update((x) => ({ ...x, cut: undefined }));
    s.input(CONTINUE);
  }

  /** После смены очереди: строки её сессий, побудка, оборванные. */
  function settled(slot: string, sameToo = false): void {
    for (const s of queued(slot)) {
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

  /** Кого поставить в очередь: по её порядку, окна свежие у Claude; у порога — следующий. */
  async function reserve(slot: string, from: string | null): Promise<string | null> {
    for (const name of book().slots[slot] ?? []) {
      if (name === from || !usable(book().accounts[name], modelOf(slot), now())) continue;
      if (stale(book().accounts[name]!, FRESH_S, now())) await poll(name);
      if (usable(book().accounts[name], modelOf(slot), now())) return name;
    }
    return null;
  }

  /** Подмена без человека: порог или отказ модели. Смена в каждой очереди, где аккаунт стоит сейчас, — свой шаг линии;
   *  шаг сначала смотрит, стоит ли очередь всё ещё на нём: о пороге говорят сессии всех очередей, а меняется каждая один раз. */
  function swapFrom(from: string, why: string, told?: string): void {
    for (const slot of slotNames().filter((n) => current(n) === from)) {
      background(async () => {
        if (current(slot) !== from) return;
        // told — очередь, чьей сессии Claude отказал; остальные меняются, только если аккаунт не годен их виду
        if (slot !== told && usable(book().accounts[from], modelOf(slot), now())) return;
        const to = await reserve(slot, from);
        if (!to) {
          const w = waitAt(slot);
          host.log.info("account_wait", { why: `очередь ${slot}: все аккаунты у порога — жду сброса${w ? ` ${clock(w)}` : ""}` });
          return settled(slot);
        }
        try {
          await put(slot, to, why);
        } finally {
          settled(slot);
        }
      });
    }
  }

  /** Вход перестал быть годным: очереди, где он стоит, идут на следующего. */
  function lost(email: string): void {
    swapFrom(email, "вход пропал");
    plan();
  }

  /** Почта нового входа известна: файл на место, запись; первый вход на машине без очередей заводит очередь main. */
  function landed(email: string, info: SignedIn): Promise<void> {
    return serial(async () => {
      await dirs.settle(email);
      const first = !slotNames().length;
      write((b) => {
        b.accounts[email] = { ...(b.accounts[email] ?? { limits: {} }), ...info, login: "ok" };
        if (first) b.slots[MAIN] = [email];
      });
      if (first) await put(MAIN, email, "первый вход");
      plan();
      host.log.info("account_login", { why: `${email}: вход` });
      void host.call(ledgerAdd, { what: "account.login", machine: host.machine, text: `вход ${email} на ${host.machine}` }).catch(() => {});
    });
  }

  /** Час сброса очереди: её аккаунт снова годен или в запасе появился годный. */
  async function reset(slot: string): Promise<void> {
    if (!book().slots[slot]) return;
    const cur = current(slot);
    if (cur && usable(book().accounts[cur], modelOf(slot), now())) {
      host.log.info("account_reset", { why: `очередь ${slot}: сброс ${cur} — продолжаю` });
      return settled(slot, true);
    }
    const to = await reserve(slot, cur);
    if (to) {
      await put(slot, to, "сброс");
      settled(slot);
    } else plan();
  }
  /** Окно из сообщения сессии. Сброс совпал с окном другого аккаунта порядка — это поздний ответ прежнего. */
  function limitEvent(s: SessionApi, slot: string, cur: string, info: { status?: string; rateLimitType?: string; utilization?: number; resetsAt?: number }): void {
    const type = info.rateLimitType;
    if (!type) return;
    const rejected = info.status === "rejected";
    const utilization = rejected ? 1 : info.utilization;
    if (utilization === undefined) return;
    const resetsAt = info.resetsAt ?? 0;
    const { accounts, slots } = book();
    const order = slots[slot] ?? [];
    const same = (n: string) => {
      const known = accounts[n]?.limits[type]?.resetsAt;
      return known !== undefined && Math.abs(known - resetsAt) <= RESET_DRIFT_S;
    };
    const owner = same(cur) ? cur : (order.find((n) => n !== cur && same(n)) ?? cur);
    const at = now();
    write((b) => {
      const a = b.accounts[owner];
      if (a && !((a.limits[type]?.at ?? 0) > at)) a.limits[type] = { utilization, resetsAt, at };
    });
    if (owner !== cur) {
      host.log.info("account_late", { callsign: s.callsign, why: `поздний ответ ${owner}` });
      return plan();
    }
    const model = modelOf(slot);
    if (!watched(model, type)) {
      // окно не её: число записано, аккаунт не меняется; отказ сессия видит словами
      if (rejected) {
        foreign.add(s.callsign);
        seatOf(s).update((x) => ({ ...x, cut: undefined }));
      }
      return plan();
    }
    if (rejected) seatOf(s).update((x) => ({ ...x, cut: cur }));
    const a = book().accounts[cur];
    if (rejected) swapFrom(cur, "отказ", slot);
    else if (a && over(a, model, at)) swapFrom(cur, `${WINDOW_NAMES[type] ?? type} ${Math.round(utilization * 100)} %`);
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
      const name = s.spec.slot;
      if (!name || slotOf(s)) return { to: ANTHROPIC };
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

  const dropSlot = (b: Book, slot: string) => {
    delete b.slots[slot];
    delete b.models?.[slot];
  };

  /** Завести, изменить, удалить очередь: имени нет — заводится; пустой порядок удаляет очередь без сессий. */
  async function slotSet(slot: string, order: string[], model?: SlotModel): Promise<void> {
    if (!SLOT_NAME.test(slot)) throw new Refusal("bad_input", `имя очереди ${JSON.stringify(slot)}: латиница, цифры, «-» и «_»`);
    const { accounts } = book();
    const ghost = order.find((n) => !accounts[n]);
    if (ghost) throw new Refusal("no_account", `${ghost}: такого аккаунта на машине нет`);
    if (!order.length) {
      if (queued(slot).length) throw new Refusal("has_sessions", `на очереди ${slot} есть сессии: ${queued(slot).map((s) => s.callsign).join(", ")}`);
      await dirs.unplace(slot);
      write((b) => dropSlot(b, slot));
      return plan();
    }
    // вид: назван — он; у новой очереди не назван — fable; у существующей — прежний
    const was = book().slots[slot] ? modelOf(slot) : undefined;
    const next = model ?? was ?? "fable";
    if (was && next !== was) {
      const alien = queued(slot).filter((s) => s.spec.model && !fits(next, s.spec.model));
      if (alien.length) throw new Refusal("has_sessions", `на очереди ${slot} сессии с моделью другого вида: ${alien.map((s) => `${s.callsign} (${s.spec.model})`).join(", ")} — сначала смените им модель или очередь`);
    }
    const cur = current(slot);
    if (!cur || !order.includes(cur)) {
      const first = order.find((n) => accounts[n]!.login === "ok");
      if (!first) throw new Refusal("no_reserve", "в порядке нет вошедшего аккаунта");
      await put(slot, first, cur ? "новый порядок" : "новая очередь");
    }
    write((b) => {
      b.slots[slot] = order;
      (b.models ??= {})[slot] = next;
    });
    // новому виду аккаунт может быть не годен: очередь сразу идёт на следующего
    const stays = current(slot);
    if (stays && !usable(book().accounts[stays], next, now())) {
      const to = await reserve(slot, stays);
      if (to) await put(slot, to, "вид очереди");
    }
    // сессии без своей модели идут на модели очереди: новая вступает в силу с новым процессом
    if (was && next !== was) for (const s of queued(slot)) if (!s.spec.model && s.state !== "stopped" && s.state !== "failed") void s.restart();
    settled(slot);
  }

  /** Удаление одним запросом: сначала видно, что каждой очереди с сессиями есть кого поставить, потом шаги. */
  async function accountRemove(name: string): Promise<void> {
    if (!book().accounts[name]) throw new Refusal("no_account", `аккаунта ${name} на машине нет`);
    const inside = slotNames().filter((n) => book().slots[n]!.includes(name));
    const next = new Map<string, string | null>();
    for (const slot of inside) {
      const to = current(slot) === name ? await reserve(slot, name) : current(slot);
      if (!to && queued(slot).length) throw new Refusal("no_reserve", `очередь ${slot}: в запасе нет вошедшего аккаунта ниже порога — на ней остались бы сессии без аккаунта`);
      next.set(slot, to);
    }
    for (const slot of inside) {
      const to = next.get(slot)!;
      if (current(slot) === name) {
        if (to) await put(slot, to, "удаление аккаунта");
        else await dirs.unplace(slot);
      }
      // очередь есть, пока в ней есть аккаунт
      write((b) => {
        const rest = b.slots[slot]!.filter((n) => n !== name);
        if (rest.length) b.slots[slot] = rest;
        else dropSlot(b, slot);
      });
      if (book().slots[slot]) settled(slot);
      else await dirs.unplace(slot);
    }
    plan();
    try {
      rmSync(dirs.accDir(name), { recursive: true, force: true });
    } catch (e) {
      throw new Refusal("account_dir_busy", `${name}: папка аккаунта занята — ${say(e)}`);
    }
    write((b) => void delete b.accounts[name]);
    host.log.info("account_remove", { why: `${name}: аккаунт удалён` });
  }

  /** «Сменить сейчас» в названной очереди: названный аккаунт или следующий годный по её порядку. */
  async function slotSwap(slot: string, account: string | undefined): Promise<string> {
    if (!book().slots[slot]) throw new Refusal("no_slot", `очереди ${slot} на ${host.machine} нет; ${slotsWord()}`);
    const cur = current(slot);
    if (account) {
      assertLogin(account);
      if (account === cur) return account;
      if (!book().slots[slot]!.includes(account)) write((b) => void b.slots[slot]!.push(account));
      await put(slot, account, "по запросу");
      settled(slot);
      return account;
    }
    const to = await reserve(slot, cur);
    if (!to) throw new Refusal("no_reserve", `в очереди ${slot} нет другого вошедшего аккаунта ниже порога`);
    await put(slot, to, "по запросу");
    settled(slot);
    return to;
  }

  /** Когда лимиты аккаунта замерены последний раз, секунды; замеров нет — 0. */
  const measured = (a: Account) => Math.max(0, ...Object.values(a.limits).map((w) => w.at ?? 0));

  function rowOf(name: string, a: Account, t: number): AccountOut {
    // сколько сессий идёт на аккаунте сейчас — по всем очередям, где он стоит
    const sessions = host.sessions().filter((s) => { const slot = slotOf(s); return !!slot && current(slot) === name; }).length;
    return {
      id: name, kind: "claude", email: name, ...(a.plan ? { plan: a.plan } : {}),
      limits: Object.entries(shown(a, t).limits).map(([w, v]) => ({ name: w, used: v.utilization, ...(v.resetsAt ? { resets: v.resetsAt * 1000 } : {}), ...(v.at ? { at: v.at * 1000 } : {}) })),
      ...(measured(a) ? { at: measured(a) * 1000 } : {}), ...(a.expires ? { expires: a.expires * 1000 } : {}),
      ok: a.login === "ok", ...(a.login === "ok" ? {} : { why: "входа нет" }), sessions,
    };
  }

  /** Очередь наружу: порядок, кто стоит сейчас, час сброса у ждущей, сколько на ней сессий. */
  function slotRow(name: string): SlotOut {
    const account = current(name);
    const wait = waitAt(name);
    return { name, model: modelOf(name), order: book().slots[name]!, ...(account ? { account } : {}), ...(wait ? { wait: wait * 1000 } : {}), sessions: queued(name).length };
  }

  /** Ключ флота с таким именем есть; ни очереди, ни ключа — отказ no_slot с очередями машины. */
  async function keyOf(name: string): Promise<KeyConfig> {
    try {
      return await takeKey(name);
    } catch (e) {
      if ((e as Refusal).word !== "no_account") throw e;
      throw new Refusal("no_slot", `${name}: ни очереди, ни ключа флота с таким именем нет; ${slotsWord()}`);
    }
  }

  return {
    name: "host-accounts",
    api,
    spec: {
      async slot(value) {
        const name = value as string;
        if (book().slots[name]) {
          const cur = current(name);
          if (!cur) throw new Refusal("not_logged_in", `очередь ${name} на ${host.machine} пуста: поставьте в неё аккаунт`);
          return assertLogin(cur);
        }
        // закрепления за почтой нет: один аккаунт — очередь из одного
        if (EMAIL.test(name)) throw new Refusal("no_slot", `${name} — почта, а не очередь; ${slotsWord()}`);
        await keyOf(name);
      },
    },
    /** Очередь диктует выбор модели: в fable — только Fable, в остальных — всё, кроме Fable. */
    doc(spec) {
      const name = spec.slot;
      if (!name || !spec.model || !book().slots[name]) return;
      const model = modelOf(name);
      if (fits(model, spec.model)) return;
      throw new Refusal("model_not_in_slot", model === "fable" ? `очередь ${name} — только для Fable: модель ${spec.model} идёт в очереди для остальных моделей; ${slotsWord()}` : `очередь ${name} — для моделей, кроме Fable: ${spec.model} идёт в очереди вида fable; ${slotsWord()}`);
    },
    fill: {
      /** Очередь не названа: на машине одна — в неё, и её имя встаёт в документ; несколько — назвать; ни одной — входа нет. */
      slot() {
        const names = slotNames();
        if (names.length === 1) return names[0];
        if (names.length) throw new Refusal("slot_required", `назовите очередь: ${slotsWord()}`);
        throw new Refusal("not_logged_in", `на ${host.machine} нет входа Claude: войдите в аккаунт или выберите ключ флота`);
      },
    },
    async applied(s, keys) {
      if (!keys.includes("slot")) return;
      if (slotOf(s)) seatOf(s).set(undefined);
      else seatOf(s).set({ key: await takeKey(s.spec.slot!) });
      // новый аккаунт вступает в силу с новым процессом
      if (s.state !== "stopped" && s.state !== "failed") void s.restart();
    },
    // подъём настройки ключа берёт из записи сессии и флот не спрашивает: на старте связи ещё нет
    async compose(s) {
      const name = s.spec.slot;
      if (!name) throw new Refusal("no_slot", `у ${s.callsign} не названа очередь; ${slotsWord()}`);
      if (slotOf(s)) {
        if (!current(name)) throw new Refusal("not_logged_in", `очередь ${name} на ${host.machine} пуста: поставьте в неё аккаунт`);
        // модель не задана — модель очереди: Fable в fable, Opus в остальных
        return { env: { CLAUDE_SECURESTORAGE_CONFIG_DIR: dirs.slotDir(name), ...(s.spec.model ? {} : { ANTHROPIC_MODEL: DEFAULT_MODEL[modelOf(name)] }) } };
      }
      let config = seatOf(s).get()?.key;
      if (!config) {
        config = await keyOf(name);
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
      const slot = slotOf(s);
      const account = slot ? current(slot) : s.spec.slot;
      // очередь ждёт сброса лимита — сессия на ней стоит до этого часа
      const wait = slot ? waitAt(slot) : null;
      return { ...(account ? { account } : {}), ...(wait ? { wait: wait * 1000 } : {}) };
    },
    on: {
      event(s, m) {
        // у ключа флота нет окон и запасных: 429 — обычная ошибка хода, сессия видит её словами
        const slot = slotOf(s);
        if (!slot) return;
        const cur = current(slot);
        if (!cur) return;
        const msg = m as { type: string; error?: string; rate_limit_info?: Parameters<typeof limitEvent>[3] };
        if (msg.type === "rate_limit_event" && msg.rate_limit_info) limitEvent(s, slot, cur, msg.rate_limit_info);
        if (msg.type === "assistant" && msg.error === "rate_limit" && !foreign.has(s.callsign) && !seatOf(s).get()?.cut) seatOf(s).update((x) => ({ ...x, cut: cur }));
        if (msg.type !== "result") return;
        const cut = seatOf(s).get()?.cut;
        // отказ без события лимита: подмена на конце хода
        if (!foreign.delete(s.callsign) && cut && cut === current(slot)) swapFrom(cut, "отказ", slot);
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
        // имя сначала ищется среди очередей: сессия с именем очереди на ключе не считается
        for (const k of keys) accounts.push({ id: k.name, kind: "key", ok: true, sessions: host.sessions().filter((s) => s.spec.slot === k.name && !slotOf(s)).length, provider: k.provider, ...(k.base ? { base: k.base } : {}), ...(k.model ? { model: k.model } : {}), ...(k.models && Object.keys(k.models).length ? { models: k.models } : {}) });
        return { accounts, slots: slotNames().map(slotRow) };
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
      async "slot.set"({ slot, order, model }: { slot: string; order: string[]; model?: SlotModel }) {
        await serial(() => slotSet(slot, order, model));
        return {};
      },
      async "slot.swap"({ slot, account }: { slot: string; account?: string }) {
        return { account: await serial(() => slotSwap(slot, account)) };
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
