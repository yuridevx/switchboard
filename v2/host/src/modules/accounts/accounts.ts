// Аккаунты машины: входы Claude с лимитами, именованные очереди аккаунтов и ключи флота. Имя аккаунта — его почта.
// Очередь — один список аккаунтов и два места на нём: на месте fable идут сессии Fable, на месте other — остальные модели.
// Место — ссылка на диске на папку того, кто стоит сейчас: кто на нём, знает только ссылка. Числа лимитов — только из ответа Claude об аккаунте.
// Сессия стоит в очереди или на ключе флота (поле slot её документа). Все изменения всех очередей машины идут одной линией.
// Значение ключа флота — только в памяти; настройки ключа — в записи сессии: подъём читает их без связи.
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { keysList, keysValue, laneOf, ledgerAdd, READ_MS, Refusal, within, type Account as AccountOut, type Lane, type Slot as SlotOut } from "@sb/protocol";
import type { HostApi, Module, SessionApi } from "../../core/contract.ts";
import type { Account } from "./limits.ts";
import { expired, FABLE, fits, nextReset, place, read, shown, stale, usableAt, WEEK, windowOf } from "./limits.ts";
import { envOf, folders, type Folders } from "./links.ts";
import { signin, type SignedIn } from "./signin.ts";

/** slots — очереди: имя → аккаунты по порядку; очередь есть, пока в ней есть аккаунт. */
type Book = { accounts: Record<string, Account>; slots: Record<string, string[]> };
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
/** Имя очереди — оно же начало имени ссылок её мест. */
const SLOT_NAME = /^[a-z0-9][a-z0-9_-]*$/;
const LANES: Lane[] = ["fable", "other"];
const LANE_WORD: Record<Lane, string> = { fable: "Fable", other: "остальные" };
/** Числа аккаунта старше этого — спросить у Claude: расход на других машинах видно только там. Чаще аккаунт не спрашивается. */
const FRESH_S = 120;
const POLL_MS = READ_MS - 2_000;
/** Один аккаунт на разных машинах: 17:59:59 и 18:00:00. */
const RESET_DRIFT_S = 2;
const CONTINUE = "Продолжай";
/** Модель сессии, у которой своя не названа. */
const DEFAULT_MODEL = "fable";
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
  /** сессии, чей отказ в этом ходе назвал окно, которое аккаунт не закрывает: место из-за него не уходит */
  const foreign = new Set<string>();
  /** место, на котором запущен процесс сессии: смена модели через границу Fable — перезапуск на другом месте */
  const started = new Map<string, Lane>();
  let auth: ReturnType<typeof signin>;

  const shelf = () => host.store<Book>();
  const book = (): Book => shelf().get() ?? { accounts: {}, slots: {} };
  const write = (fn: (b: Book) => void) => void shelf().update((b = { accounts: {}, slots: {} }) => (fn(b), b));
  const seatOf = (s: SessionApi) => s.store<Seat>();
  const slotNames = () => Object.keys(book().slots);
  /** Кто стоит на месте очереди сейчас. */
  const current = (slot: string, lane: Lane) => dirs.inLane(slot, lane);
  /** Очередь сессии: имя из её документа, если такая очередь есть на машине; иначе это ключ флота. Имя сначала ищется среди очередей. */
  const slotOf = (s: SessionApi): string | null => (s.spec.slot && book().slots[s.spec.slot] ? s.spec.slot : null);
  /** Место сессии — по её модели: одно определение в договоре. */
  const laneOfSession = (s: SessionApi) => laneOf(s.spec.model);
  /** Сессии очереди; с местом — только его. */
  const queued = (slot: string, lane?: Lane) => host.sessions().filter((s) => slotOf(s) === slot && (!lane || laneOfSession(s) === lane));
  /** Аккаунт, на котором сессия идёт сейчас. */
  const accountOf = (s: SessionApi) => { const slot = slotOf(s); return slot ? current(slot, laneOfSession(s)) : null; };
  /** Очереди, где аккаунт стоит сейчас хотя бы на одном месте. */
  const standsIn = (account: string) => slotNames().filter((n) => LANES.some((l) => current(n, l) === account));
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

  /** Место ждёт сброса: его аккаунт не годен и годного в очереди нет. Нигде не записано — считается из списка и лимитов.
   *  Остальные модели без своей половины идут из запаса Fable, поэтому ждут, только когда нет и его. */
  function waitAt(slot: string, lane: Lane): number | null {
    const { accounts, slots } = book();
    const order = slots[slot] ?? [];
    const cur = current(slot, lane);
    const t = now();
    if (!cur || place(order, accounts, { [lane]: cur }, t)[lane]) return null;
    const soon = (a: Account) => (lane === "fable" ? [usableAt(a, "fable", t)] : [usableAt(a, "other", t), usableAt(a, "fable", t)]).filter(Boolean);
    const times = order.filter((n) => accounts[n]?.login === "ok").flatMap((n) => soon(accounts[n]!));
    return times.length ? Math.min(...times) : null;
  }

  /** Побудка одна на машину: на ближайший сброс окна у аккаунтов очередей. По ней места пересматриваются;
   *  где сбросилась неделя — выбирают заново: ближний сброс теперь у другого аккаунта. */
  function plan(): void {
    clearTimeout(wake);
    wake = undefined;
    if (stopping) return;
    const { accounts, slots } = book();
    const t = now();
    const at = Math.min(...[...new Set(Object.values(slots).flat())].map((n) => (accounts[n] ? nextReset(accounts[n]!, t) : Infinity)));
    if (!Number.isFinite(at)) return;
    wake = setTimeout(() => {
      const gone = Object.keys(book().accounts).filter((n) => expired(book().accounts[n], now()));
      for (const slot of slotNames()) background(() => repick(slot, "сброс", { fresh: book().slots[slot]!.some((n) => gone.includes(n)), sameToo: true }));
      // прошедшая неделя снята с записи: побудка по ней — один раз
      background(async () => write((b) => { for (const n of gone) { delete b.accounts[n]?.limits[WEEK]; delete b.accounts[n]?.limits[FABLE]; } }));
      background(async () => plan());
    }, Math.max(0, at * 1000 - Date.now()));
    wake.unref();
  }

  /** Единственная смена аккаунта места: ссылка, строки сессий, журнал машины и флота. */
  async function put(slot: string, lane: Lane, to: string, why: string): Promise<void> {
    const from = current(slot, lane);
    await dirs.place(slot, lane, to);
    for (const s of queued(slot)) s.sync();
    const text = `очередь ${slot} · ${LANE_WORD[lane]}: ${from ?? "—"} → ${to} · ${why}`;
    host.log.info("account_swap", { why: text });
    void host.call(ledgerAdd, { what: "account.swapped", machine: host.machine, text }).catch(() => {});
  }

  /** Сессия с оборвавшимся ходом продолжает, когда свободна; тот же аккаунт — только после его сброса. */
  function resume(s: SessionApi, sameToo = false): void {
    const seat = seatOf(s).get();
    const slot = slotOf(s);
    if (!seat?.cut || s.state !== "idle" || !slot) return;
    if (seat.cut === current(slot, laneOfSession(s)) && !sameToo) return;
    seatOf(s).update((x) => ({ ...x, cut: undefined }));
    s.input(CONTINUE);
  }

  /** После пересмотра очереди: строки её сессий, побудка, оборванные. */
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
    // время вопроса пишется до ответа: Claude молчит — следующий вопрос всё равно не раньше порога свежести
    write((b) => { if (b.accounts[name]) b.accounts[name]!.asked = now(); });
    const probe = host.probe({ env: envOf(dirs.accDir(name)) });
    polls.add(probe);
    try {
      const u = await within(probe.sdk(USAGE, { skipBehaviors: true }), POLL_MS, `не ответил за ${POLL_MS / 1000} с`);
      const fresh = read(u, now());
      write((b) => { if (b.accounts[name]) Object.assign(b.accounts[name]!.limits, fresh); });
    } catch (e) {
      host.log.warn("poll", { why: `${name}: опрос лимитов — ${say(e)}` });
    } finally {
      polls.delete(probe);
      probe.close();
    }
  }

  /** Пересмотр мест очереди — шаг линии. Место стоит, пока его аккаунт годен; иначе берёт годный с ближним сбросом недели.
   *  fresh — у аккаунта очереди сбросилась неделя: места выбирают заново. bar — пара, которой Claude только что отказал. */
  async function repick(slot: string, why: string, opts: { fresh?: boolean; sameToo?: boolean; bar?: { lane: Lane; account: string } } = {}): Promise<void> {
    const order = book().slots[slot];
    if (!order) return;
    const pick = () => place(order, book().accounts, opts.fresh ? {} : { fable: current(slot, "fable"), other: current(slot, "other") }, now(), opts.bar);
    let p = pick();
    // новый аккаунт места — только со свежими числами: расход на других машинах видно у Claude; вопросов — не больше, чем аккаунтов
    for (let i = 0; i < order.length; i++) {
      const ask = [...new Set(LANES.flatMap((l) => (p[l] && p[l] !== current(slot, l) && stale(book().accounts[p[l]!]!, FRESH_S, now()) ? [p[l]!] : [])))];
      if (!ask.length) break;
      await Promise.all(ask.map(poll));
      p = pick();
    }
    try {
      for (const lane of LANES) {
        const cur = current(slot, lane);
        const stays = cur && order.includes(cur) ? cur : undefined;
        // годного нет — место стоит, где стояло; ссылки ещё нет — на первом вошедшем: сессии нужен вход, чтобы дождаться сброса
        const to = p[lane] ?? stays ?? order.find((n) => book().accounts[n]?.login === "ok");
        if (to && to !== cur) await put(slot, lane, to, why);
        if (!p[lane] && queued(slot, lane).length && (opts.bar?.lane === lane || to !== cur)) {
          const w = waitAt(slot, lane);
          host.log.info("account_wait", { why: `очередь ${slot} · ${LANE_WORD[lane]}: годного аккаунта нет — жду сброса${w ? ` ${clock(w)}` : ""}` });
        }
      }
    } finally {
      settled(slot, opts.sameToo);
    }
  }

  /** Числа аккаунта изменились или он выбыл: очереди, где он стоит, пересматриваются — каждая своим шагом линии. */
  function moved(account: string, why: string, bar?: { lane: Lane; account: string }, told?: string): void {
    for (const slot of standsIn(account)) background(() => repick(slot, why, slot === told ? { bar } : {}));
  }

  /** Сессия работает, а числам её аккаунта больше порога свежести — один вопрос Claude и пересмотр очередей, где аккаунт стоит. */
  function tick(account: string): void {
    const a = book().accounts[account];
    if (!a || stopping || polling.has(account) || !stale(a, FRESH_S, now())) return;
    void poll(account).then(() => moved(account, "порог"));
  }

  /** Вход перестал быть годным: очереди, где он стоит, идут на следующего. */
  function lost(email: string): void {
    moved(email, "вход пропал");
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
      // вход вернулся: очереди, где аккаунт в списке, пересматриваются
      for (const slot of slotNames().filter((n) => book().slots[n]!.includes(email))) await repick(slot, first ? "первый вход" : "вход");
      plan();
      host.log.info("account_login", { why: `${email}: вход` });
      void host.call(ledgerAdd, { what: "account.login", machine: host.machine, text: `вход ${email} на ${host.machine}` }).catch(() => {});
    });
  }

  /** Отказ Claude по окну лимита: окно закрыто до сброса — это факт, он пишется сразу; числа следом уточняет опрос.
   *  Сброс совпал с окном другого аккаунта очереди — это поздний ответ прежнего. */
  function rejected(s: SessionApi, slot: string, lane: Lane, cur: string, info: { rateLimitType?: string; resetsAt?: number }): void {
    const name = info.rateLimitType ? windowOf(info.rateLimitType) : undefined;
    if (!name) {
      // окно не закрывает аккаунт: место не уходит; отказ сессия видит словами
      foreign.add(s.callsign);
      seatOf(s).update((x) => ({ ...x, cut: undefined }));
      return;
    }
    const resetsAt = info.resetsAt ?? 0;
    const { accounts, slots } = book();
    const same = (n: string) => {
      const known = accounts[n]?.limits[name]?.resetsAt;
      return known !== undefined && Math.abs(known - resetsAt) <= RESET_DRIFT_S;
    };
    const owner = same(cur) ? cur : ((slots[slot] ?? []).find((n) => n !== cur && same(n)) ?? cur);
    const at = now();
    write((b) => {
      const a = b.accounts[owner];
      if (a) a.limits[name] = { ...a.limits[name], utilization: 1, resetsAt, at };
    });
    seatOf(s).update((x) => ({ ...x, cut: owner }));
    if (owner !== cur) {
      host.log.info("account_late", { callsign: s.callsign, why: `поздний ответ ${owner}` });
      return plan();
    }
    void poll(cur).then(() => moved(cur, "отказ", { lane, account: cur }, slot));
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

  /** Снять очередь: ссылки обоих мест и запись. */
  async function dropSlot(slot: string): Promise<void> {
    for (const lane of LANES) await dirs.unplace(slot, lane);
    write((b) => void delete b.slots[slot]);
  }

  /** Завести, изменить, удалить очередь: имени нет — заводится; пустой список удаляет очередь без сессий. */
  async function slotSet(slot: string, order: string[]): Promise<void> {
    if (!SLOT_NAME.test(slot)) throw new Refusal("bad_input", `имя очереди ${JSON.stringify(slot)}: латиница, цифры, «-» и «_»`);
    const { accounts } = book();
    const ghost = order.find((n) => !accounts[n]);
    if (ghost) throw new Refusal("no_account", `${ghost}: такого аккаунта на машине нет`);
    if (!order.length) {
      if (queued(slot).length) throw new Refusal("has_sessions", `на очереди ${slot} есть сессии: ${queued(slot).map((s) => s.callsign).join(", ")}`);
      await dropSlot(slot);
      return plan();
    }
    if (!order.some((n) => accounts[n]!.login === "ok")) throw new Refusal("no_reserve", "в списке нет вошедшего аккаунта");
    const existed = !!book().slots[slot];
    write((b) => void (b.slots[slot] = order));
    // место, чей аккаунт ушёл из списка, выбирает заново
    await repick(slot, existed ? "новый порядок" : "новая очередь");
  }

  /** Удаление одним запросом: сначала видно, что каждому месту с сессиями есть куда встать, потом шаги. */
  async function accountRemove(name: string): Promise<void> {
    if (!book().accounts[name]) throw new Refusal("no_account", `аккаунта ${name} на машине нет`);
    const inside = slotNames().filter((n) => book().slots[n]!.includes(name));
    for (const slot of inside) {
      const rest = book().slots[slot]!.filter((n) => n !== name);
      const p = place(rest, book().accounts, { fable: current(slot, "fable"), other: current(slot, "other") }, now());
      const stuck = LANES.find((l) => current(slot, l) === name && !p[l] && queued(slot, l).length);
      if (stuck) throw new Refusal("no_reserve", `очередь ${slot}: годного вошедшего аккаунта в списке нет — на ней остались бы сессии без аккаунта`);
    }
    for (const slot of inside) {
      const rest = book().slots[slot]!.filter((n) => n !== name);
      // очередь есть, пока в ней есть аккаунт
      if (!rest.length) { await dropSlot(slot); continue; }
      write((b) => void (b.slots[slot] = rest));
      await repick(slot, "удаление аккаунта");
      for (const lane of LANES) if (current(slot, lane) === name) await dirs.unplace(slot, lane);
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

  /** «Сменить сейчас» у места очереди: названный аккаунт или следующий годный. Место стоит на нём, пока он годен и пока не сбросилась неделя. */
  async function slotSwap(slot: string, lane: Lane, account: string | undefined): Promise<string> {
    if (!book().slots[slot]) throw new Refusal("no_slot", `очереди ${slot} на ${host.machine} нет; ${slotsWord()}`);
    const cur = current(slot, lane);
    if (account) {
      assertLogin(account);
      if (account === cur) return account;
      if (!book().slots[slot]!.includes(account)) write((b) => void b.slots[slot]!.push(account));
    }
    const to = account ?? place(book().slots[slot]!, book().accounts, {}, now(), cur ? { lane, account: cur } : undefined)[lane];
    if (!to) throw new Refusal("no_reserve", `в очереди ${slot} нет другого вошедшего аккаунта ниже порога`);
    await put(slot, lane, to, "по запросу");
    settled(slot);
    return to;
  }

  function rowOf(name: string, a: Account, t: number): AccountOut {
    // сколько сессий идёт на аккаунте сейчас — по всем местам, где он стоит
    const sessions = host.sessions().filter((s) => accountOf(s) === name).length;
    const at = Math.max(0, ...Object.values(a.limits).map((w) => w.at ?? 0));
    return {
      id: name, kind: "claude", email: name, ...(a.plan ? { plan: a.plan } : {}),
      limits: Object.entries(shown(a, t).limits).map(([w, v]) => ({
        name: w, used: v.utilization, ...(v.resetsAt ? { resets: v.resetsAt * 1000 } : {}), ...(v.at ? { at: v.at * 1000 } : {}),
        ...(v.fable !== undefined ? { fable: v.fable } : {}), ...(v.hold !== undefined ? { hold: v.hold } : {}),
      })),
      ...(at ? { at: at * 1000 } : {}), ...(a.expires ? { expires: a.expires * 1000 } : {}),
      ok: a.login === "ok", ...(a.login === "ok" ? {} : { why: "входа нет" }), sessions,
    };
  }

  /** Очередь наружу: список, кто стоит на каждом месте, час сброса у ждущего места, идут ли остальные из запаса Fable, сколько на ней сессий. */
  function slotRow(name: string): SlotOut {
    const t = now();
    const lane = (l: Lane) => {
      const account = current(name, l), wait = waitAt(name, l), a = account ? book().accounts[account] : undefined;
      const over = l === "other" && !wait && !!a && !fits(a, "other", t) && fits(a, "fable", t);
      return { ...(account ? { account } : {}), ...(wait ? { wait: wait * 1000 } : {}), ...(over ? { over } : {}) };
    };
    return { name, order: book().slots[name]!, lanes: { fable: lane("fable"), other: lane("other") }, sessions: queued(name).length };
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
          const cur = current(name, "fable") ?? current(name, "other");
          if (!cur) throw new Refusal("not_logged_in", `очередь ${name} на ${host.machine} пуста: поставьте в неё аккаунт`);
          return assertLogin(cur);
        }
        // закрепления за почтой нет: один аккаунт — очередь из одного
        if (EMAIL.test(name)) throw new Refusal("no_slot", `${name} — почта, а не очередь; ${slotsWord()}`);
        await keyOf(name);
      },
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
      const live = s.state !== "stopped" && s.state !== "failed";
      if (keys.includes("slot")) {
        if (slotOf(s)) seatOf(s).set(undefined);
        else seatOf(s).set({ key: await takeKey(s.spec.slot!) });
        // новый аккаунт вступает в силу с новым процессом
        if (live) void s.restart();
        return;
      }
      // модель перешла границу Fable: сессия идёт на другом месте очереди — вход другой, процесс новый
      if (keys.includes("model") && slotOf(s) && live && started.has(s.callsign) && started.get(s.callsign) !== laneOfSession(s)) void s.restart();
    },
    // подъём настройки ключа берёт из записи сессии и флот не спрашивает: на старте связи ещё нет
    async compose(s) {
      const name = s.spec.slot;
      if (!name) throw new Refusal("no_slot", `у ${s.callsign} не названа очередь; ${slotsWord()}`);
      if (slotOf(s)) {
        const lane = laneOfSession(s);
        if (!current(name, lane)) throw new Refusal("not_logged_in", `очередь ${name} на ${host.machine} пуста: поставьте в неё аккаунт`);
        started.set(s.callsign, lane);
        return { env: { CLAUDE_SECURESTORAGE_CONFIG_DIR: dirs.laneDir(name, lane), ...(s.spec.model ? {} : { ANTHROPIC_MODEL: DEFAULT_MODEL }) } };
      }
      started.delete(s.callsign);
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
      const account = slot ? current(slot, laneOfSession(s)) : s.spec.slot;
      // место ждёт сброса лимита — сессия на нём стоит до этого часа
      const wait = slot ? waitAt(slot, laneOfSession(s)) : null;
      return { ...(account ? { account } : {}), ...(wait ? { wait: wait * 1000 } : {}) };
    },
    on: {
      event(s, m) {
        // у ключа флота нет окон и запасных: 429 — обычная ошибка хода, сессия видит её словами
        const slot = slotOf(s);
        if (!slot) return;
        const lane = laneOfSession(s);
        const cur = current(slot, lane);
        if (!cur) return;
        const msg = m as { type: string; error?: string; rate_limit_info?: { status?: string; rateLimitType?: string; resetsAt?: number } };
        if (msg.type === "rate_limit_event" && msg.rate_limit_info?.status === "rejected") rejected(s, slot, lane, cur, msg.rate_limit_info);
        if (msg.type === "assistant" && msg.error === "rate_limit" && !foreign.has(s.callsign) && !seatOf(s).get()?.cut) seatOf(s).update((x) => ({ ...x, cut: cur }));
        // сессия работает: числа её аккаунта не старше порога свежести
        tick(cur);
        if (msg.type !== "result") return;
        const cut = seatOf(s).get()?.cut;
        // отказ без события лимита: место уходит на конце хода
        if (!foreign.delete(s.callsign) && cut && cut === current(slot, lane)) moved(cut, "отказ", { lane, account: cut }, slot);
      },
      state(s, state) {
        if (state === "idle") resume(s);
      },
      removed(callsign) {
        started.delete(callsign);
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
        // свежие числа — повод пересмотреть места
        if (stale_.length) for (const slot of slotNames()) background(() => repick(slot, "порог"));
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
      async "slot.set"({ slot, order }: { slot: string; order: string[] }) {
        await serial(() => slotSet(slot, order));
        return {};
      },
      async "slot.swap"({ slot, lane, account }: { slot: string; lane: Lane; account?: string }) {
        return { account: await serial(() => slotSwap(slot, lane, account)) };
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
      // очередь без ссылки места (новая раскладка, новая машина) встаёт по правилу
      for (const slot of slotNames()) if (LANES.some((l) => !current(slot, l))) background(() => repick(slot, "запуск"));
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
