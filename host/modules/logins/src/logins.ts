// Модуль logins: входы Claude на машине и слоты. У каждого аккаунта своя папка Claude (CLAUDE_CONFIG_DIR): вход, почта,
// тариф. Слот — ссылка по имени (main, bot) на папку аккаунта: junction на Windows, symlink на Linux; сессии слота получают
// её в CLAUDE_SECURESTORAGE_CONFIG_DIR и читают вход перед каждым вызовом модели. Поэтому один аккаунт стоит хоть в
// нескольких слотах, а токен, обновлённый claude, сразу ложится домой. Кто в слоте — сама ссылка, больше нигде.
// Аккаунт слота у порога — ссылка перевешивается на следующего из запаса; процессы не трогаются. Подмена, сброс, правка
// порядка и удаление идут одной очередью. Ссылку перевешиваем под блокировкой обновления входа claude
// (.oauth_refresh.lock в папке входа): claude держит её на время обновления (опыт 1 ноя: ~0,7 с), свежую чужую ждёт.
// С claude говорит короткими процессами без сессии (host.probe) и командой claude auth status (host.cli).
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import type { Stats } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { CALL_MS, READ_MS, within } from "@switchboard/protocol";
import { isRefusal, refuse } from "@switchboard/host";
import type { Ctx, Frame, Host, Module, Probe, SDKMessage, Session, SessionState } from "@switchboard/host";

/** Окно лимита: доля 0…1, час сброса и откуда значение (event — поток слота, poll — свой опрос). */
export type Window = { utilization: number; resetsAt: number; at: number; src: string };

/** Запись аккаунта в хранилище. */
export type Account = {
  login: "ok" | "none" | "pending";
  email?: string;
  plan?: string;
  checked?: number;
  limits: Record<string, Window>;
};

export type Accounts = Record<string, Account>;

/** Раздел машины: аккаунты и порядок аккаунтов каждого слота. */
export type Machine = { accounts: Accounts; slots: Record<string, string[]> };
/** Раздел сессии: слот и «ход оборван лимитом» (на каком аккаунте). */
type Mine = { slot: string | null; cut?: string };

/** Файл входа claude в папке Claude (или в CLAUDE_SECURESTORAGE_CONFIG_DIR). */
export const CREDENTIALS = ".credentials.json";
/** Блокировка обновления входа claude — папка рядом с файлом входа (mkdir). */
export const REFRESH_LOCK = ".oauth_refresh.lock";
/** Сколько ждать, пока claude обновляет вход: свою блокировку он держит меньше секунды. */
export const LOCK_WAIT_MS = 10_000;
/** Проверка входа — раз в 2 мин, как в claude-fleet. */
export const CHECK_MS = 120_000;
/** Предел опроса окон: на 2 с раньше предела чтения — часы страницы пошли раньше, ответ должен успеть к ней (замер: до 4,9 с). */
export const POLL_MS = READ_MS - 2_000;
/** Предел claude auth status. */
export const STATUS_MS = READ_MS;
/** Предел вызова входа у процесса claude. */
export const LOGIN_MS = CALL_MS;
/** Окна моложе двух минут — свежие: то же, что спрашивает страница аккаунтов (max_age 120). */
const FRESH_S = 120;
/** Порог: 95 % за 5 ч, 98 % за неделю (и прочие окна). */
export const limitOf = (w: string) => (w === "five_hour" ? 0.95 : 0.98);
export const CONTINUE = "Продолжай";

const USAGE = "usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET";
const NAME = /^[A-Za-z0-9_-]+$/;
const SLOT = /^[A-Za-z0-9_-]+$/;

const sec = () => Math.floor(Date.now() / 1000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hhmm = (t: number) => new Date(t * 1000).toTimeString().slice(0, 5);
const pct = (u: number) => `${Math.round(u * 100)} %`;
const winName = (w: string) => (w === "five_hour" ? "5 ч" : w === "seven_day" ? "нед." : w);
const lstat = (p: string): Stats | null => {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
};

/** Окна аккаунта, которые сейчас у порога (сброс ещё не прошёл). */
function overWindows(a: Account | undefined, now: number): Array<[string, Window]> {
  return Object.entries(a?.limits ?? {}).filter(([w, v]) => v.utilization >= limitOf(w) && !(v.resetsAt && v.resetsAt <= now));
}
export const over = (a: Account | undefined, now: number) => overWindows(a, now).length > 0;
/** Когда аккаунт снова годится: самый поздний сброс его окон у порога. */
const usableAt = (a: Account | undefined, now: number) => Math.max(0, ...overWindows(a, now).map(([, v]) => v.resetsAt || 0));

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

/** Куда ведёт ссылка слота; не ссылка или её нет — null. */
function linkTarget(p: string): string | null {
  if (!lstat(p)?.isSymbolicLink()) return null;
  return resolve(dirname(p), readlinkSync(p));
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

/**
 * Перенос двух прежних файлов в один новый. Временный код: снимается следующей версией вместе с прежними файлами.
 * Идёт до первого host.store(); прежние файлы не трогает, поэтому откат — одна выкладка. Падение до rename — перенос повторится.
 */
export function migrate(dir: string): boolean {
  const f = join(dir, "host-logins.json");
  if (existsSync(f)) return false;
  const read = (name: string) => {
    const p = join(dir, name);
    return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as { machine?: Record<string, unknown>; sessions?: Record<string, Mine> }) : null;
  };
  const was = read("host-accounts.json");
  const slots = read("host-slots.json");
  if (!was && !slots) return false;
  const accounts: Accounts = {};
  for (const [name, a] of Object.entries((was?.machine ?? {}) as Record<string, Account & { links?: unknown; err?: unknown }>)) {
    const { links: _l, err: _e, ...rest } = a;
    accounts[name] = rest;
  }
  const next = { machine: { accounts, slots: (slots?.machine?.slots ?? {}) as Machine["slots"] }, sessions: slots?.sessions ?? {} };
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${f}.tmp`, JSON.stringify(next, null, 1), { flush: true });
  renameSync(`${f}.tmp`, f);
  return true;
}

export function make() {
  let host: Host;
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopping = false;
  let checking = false;
  /** процессы входа: имя → короткий claude, ждущий код */
  const logins = new Map<string, { p: Probe; state: string | null }>();
  /** идущие опросы окон: стирание папки аккаунта закрывает их раньше */
  const polls = new Map<string, Set<Probe>>();
  /** подмена, сброс, правка порядка и удаление идут по одной */
  let chain: Promise<unknown> = Promise.resolve();
  /** таймер ожидания сброса слота */
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const store = () => host.store<Machine>();
  const mach = (): Machine => {
    const m = store().get();
    return { accounts: m?.accounts ?? {}, slots: m?.slots ?? {} };
  };
  const all = (): Accounts => mach().accounts;
  const order = (): Machine["slots"] => mach().slots;
  const dirOf = (name: string) => join(host.dataDir, "accounts", name);
  const slotDir = (slot: string) => join(host.dataDir, "slots", slot);
  const env = (name: string): Record<string, string> => ({ CLAUDE_CONFIG_DIR: dirOf(name) });
  const mine = (s: Session) => s.store<Mine>().get();
  const slotOf = (s: Session) => mine(s)?.slot ?? null;
  const save = (name: string, fn: (a: Account | undefined) => Account | undefined) =>
    store().update((cur) => {
      const m = { accounts: {}, slots: {}, ...cur } as Machine;
      const next = fn(m.accounts[name]);
      if (next) m.accounts[name] = next;
      else delete m.accounts[name];
      return m;
    });
  const need = (f: Frame): [string, Account] => {
    const name = f.account;
    const a = typeof name === "string" ? all()[name] : undefined;
    if (!a) throw refuse("no_account", `аккаунта ${String(name)} на машине нет`);
    return [name as string, a];
  };
  const setOrder = (slot: string, list: string[] | null) =>
    store().update((cur) => {
      const m = { accounts: {}, slots: {}, ...cur } as Machine;
      const slots = { ...m.slots };
      if (list) slots[slot] = list;
      else delete slots[slot];
      return { ...m, slots };
    });

  /** Кто в слоте: цель ссылки, если её папка есть и у неё есть запись аккаунта; иначе никого. */
  const whoIn = (slot: string): string | null => {
    const target = linkTarget(slotDir(slot));
    if (!target || !existsSync(target)) return null;
    return Object.keys(all()).find((n) => resolve(dirOf(n)) === target) ?? null;
  };
  const sessionsIn = (slot: string): Session[] =>
    host
      .sessions()
      .map((x) => host.session(x.callsign))
      .filter((s): s is Session => !!s && slotOf(s) === slot);

  function queue<T>(fn: () => Promise<T>): Promise<T> {
    const p = chain.then(fn, fn);
    chain = p.catch(() => undefined);
    return p;
  }

  function closeLogin(name: string): void {
    logins.get(name)?.p.close();
    logins.delete(name);
  }

  /** claude auth status с папкой аккаунта: вошёл ли. Не ответил за предел — исключение: что с входом, неизвестно. */
  async function loggedIn(name: string): Promise<boolean> {
    const r = await within(host.cli(["auth", "status"], { env: env(name) }), `${name}: auth status не ответил за ${STATUS_MS / 1000} с`, STATUS_MS);
    if (r.code !== 0) return false;
    try {
      return (JSON.parse(r.out) as { loggedIn?: boolean }).loggedIn !== false;
    } catch {
      return true; // выход 0 без JSON — вошёл
    }
  }

  /** Проверка входа всех аккаунтов: пропал — login none и строка журнала. Прежняя ещё идёт — следующий раз. */
  async function check(): Promise<void> {
    if (checking) return;
    checking = true;
    try {
      for (const [name, a] of Object.entries(all())) {
        if (stopping) return;
        if (a.login === "pending") continue;
        const ok = await loggedIn(name);
        const now = sec();
        save(name, (cur) => cur && { ...cur, login: cur.login === "pending" ? "pending" : ok ? "ok" : "none", checked: now });
        if (!ok && a.login === "ok") host.log({ kind: "stop", ev: "login_lost", account: name, why: `${name}: вход пропал` });
      }
    } finally {
      checking = false;
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

  /** Опрос лимитов коротким claude с папкой аккаунта. Не ответил за предел — процесс закрыт, прежние окна, причина в журнале. */
  async function poll(name: string): Promise<void> {
    if (stopping) return;
    const p = host.probe({ env: env(name) });
    const set = polls.get(name) ?? new Set<Probe>();
    polls.set(name, set);
    set.add(p);
    try {
      const r = (await within(p.sdk(USAGE, { skipBehaviors: true }), `не ответил за ${POLL_MS / 1000} с`, POLL_MS)) as {
        subscription_type?: string | null;
        rate_limits?: Record<string, { utilization: number | null; resets_at: string | null } | null> | null;
      };
      const windows: Record<string, { utilization: number; resetsAt: number }> = {};
      for (const [w, v] of Object.entries(r.rate_limits ?? {})) {
        if (!v || typeof v.utilization !== "number") continue;
        windows[w] = { utilization: v.utilization / 100, resetsAt: v.resets_at ? Math.floor(Date.parse(v.resets_at) / 1000) : 0 };
      }
      merge(name, windows, "poll", sec());
      if (r.subscription_type) save(name, (cur) => cur && { ...cur, plan: r.subscription_type as string });
    } catch (e) {
      host.log({ kind: "refuse", ev: "poll", account: name, why: `${name}: опрос лимитов — ${(e as Error).message}` });
    } finally {
      set.delete(p);
      if (!set.size) polls.delete(name);
      p.close();
    }
  }

  /** Окна аккаунта старше age секунд — опросить. */
  const stale = (a: Account | undefined, age: number) => sec() - Math.max(0, ...Object.values(a?.limits ?? {}).map((w) => w.at)) > age;

  /** Запись наружу: окно, чей сброс прошёл, — 0 %. */
  function view(a: Account, now: number) {
    const limits: Record<string, Window> = {};
    for (const [w, v] of Object.entries(a.limits ?? {})) limits[w] = v.resetsAt && v.resetsAt <= now ? { ...v, utilization: 0 } : v;
    return { ...a, limits };
  }

  /** Следующий по порядку слота: вошёл и ниже порога (может стоять и в другом слоте); skip — кого нельзя. */
  function candidate(slot: string, now: number, skip: string | null = whoIn(slot)): string | null {
    const accs = all();
    for (const name of order()[slot] ?? []) {
      if (name === skip) continue;
      const a = accs[name];
      if (!a || a.login !== "ok" || over(a, now)) continue;
      return name;
    }
    return null;
  }

  /** Час сброса, которого слот ждёт: в слоте аккаунт у порога и запаса нет. Считается, не хранится. */
  function waitOf(slot: string): number | null {
    const now = sec();
    const cur = whoIn(slot);
    const accs = all();
    if (!cur || !over(accs[cur], now) || candidate(slot, now, cur)) return null;
    const times = [cur, ...(order()[slot] ?? [])]
      .filter((n) => accs[n]?.login === "ok")
      .map((n) => usableAt(accs[n], now))
      .filter((t) => t > now);
    return times.length ? Math.min(...times) : null;
  }

  /** Поставить или снять таймер ожидания сброса. */
  function arm(slot: string): void {
    const t = timers.get(slot);
    if (t) clearTimeout(t);
    timers.delete(slot);
    const w = waitOf(slot);
    if (w === null) return;
    timers.set(slot, setTimeout(() => void onReset(slot), Math.max(0, w * 1000 - Date.now())));
  }

  /** Слоты машины для причины отказа: кто ждёт сброса — с часом. */
  function slotsWord(): string {
    const names = Object.keys(order());
    if (!names.length) return "На машине нет слотов";
    return `Слоты машины: ${names.map((n) => (waitOf(n) ? `${n} (ждёт сброса ${hhmm(waitOf(n)!)})` : n)).join(", ")}`;
  }

  /** Перевесить или снять ссылку слота. Ответ — прежний аккаунт; отказ — словом. */
  async function link(slot: string, to: string | null): Promise<{ from: string | null }> {
    if (to !== null) {
      const a = all()[to];
      if (!a) throw refuse("no_account", `аккаунта ${to} на машине нет`);
      if (a.login !== "ok" || !existsSync(join(dirOf(to), CREDENTIALS))) throw refuse("not_logged_in", `${to}: входа нет`);
    }
    const from = whoIn(slot);
    if (from === to && (to !== null || !lstat(slotDir(slot)))) return { from };
    const dir = slotDir(slot);
    // claude сессий слота обновляет вход в папке прежнего аккаунта — перевешиваем, пока она не занята
    await locked(from ? dirOf(from) : null, () => (to ? linkSlot(dir, dirOf(to)) : unlinkSlot(dir)));
    host.log({ ev: "place", account: to, dir, from });
    return { from };
  }

  /** Подмена в слоте: ссылка, roster, журнал машины и флота. Ответ — прежний аккаунт или отказ словом. */
  async function place(slot: string, to: string, why: string, by?: string): Promise<{ ok: true; from: string | null } | { ok: false; error: string; why?: string }> {
    let from: string | null;
    try {
      ({ from } = await link(slot, to));
    } catch (e) {
      if (!isRefusal(e)) throw e;
      host.log({ kind: "refuse", ev: "slot.swap", word: e.word, slot, why: `${slot}: подмена на ${to} — ${e.word}${e.why ? `: ${e.why}` : ""}` });
      return { ok: false, error: e.word, ...(e.why ? { why: e.why } : {}) };
    }
    // поле account в roster — сразу, а не со следующим событием сессии (живой прогон 31 окт.)
    for (const x of sessionsIn(slot)) x.refresh();
    const text = `слот ${slot}: ${from ?? "—"} → ${to} · ${why}`;
    host.log({ ev: "slot.swapped", slot, from, to, why: text });
    const sent = host.emit({ type: "ledger.add", to: ".ledger", ev: "slot.swapped", machine: host.machine, text, ...(by ? { by } : {}) });
    if (!sent.ok) host.log({ kind: "refuse", ev: "ledger.add", word: sent.error, why: `ledger.add не ушёл: ${sent.error}` });
    return { ok: true, from };
  }

  /** «Продолжай» сессиям слота, чей ход оборван лимитом и уже кончился. */
  function resume(slot: string): void {
    for (const s of sessionsIn(slot)) {
      const m = mine(s);
      if (!m?.cut || s.state !== "idle") continue;
      s.store<Mine>().set({ ...m, cut: undefined });
      s.input(CONTINUE);
    }
  }

  /**
   * Подмена по порогу или отказу: следующий по порядку; запаса нет — ждать ближайшего сброса.
   * expect — аккаунт, о котором сигнал: слот уже сменился — второй раз не меняем.
   */
  function swap(slot: string, expect: string, why: string): Promise<void> {
    return queue(async () => {
      if (stopping || whoIn(slot) !== expect) return;
      // расход аккаунта на других машинах видно только у Claude: окна кандидата — свежие; он уже у порога — следующий
      let next: string | null = null;
      for (let i = 0; i < (order()[slot]?.length ?? 0); i++) {
        const n = candidate(slot, sec());
        if (!n) break;
        if (stale(all()[n], FRESH_S)) await poll(n);
        if (!over(all()[n], sec())) {
          next = n;
          break;
        }
      }
      if (!next) {
        const w = waitOf(slot);
        arm(slot);
        if (w) host.log({ ev: "slot.wait", slot, why: `${slot}: все аккаунты у порога — жду сброса ${hhmm(w)}` });
        return;
      }
      const r = await place(slot, next, why);
      arm(slot);
      if (r.ok) resume(slot);
    });
  }

  /** Час сброса настал: подмена на годный (или в слоте свой сброс) и «Продолжай». */
  function onReset(slot: string): Promise<void> {
    timers.delete(slot);
    return queue(async () => {
      if (stopping) return;
      const now = sec();
      const cur = whoIn(slot);
      let to: string | null = cur && !over(all()[cur], now) ? cur : null;
      to ??= candidate(slot, now);
      if (!to) return arm(slot);
      if (to !== cur) {
        const r = await place(slot, to, "сброс");
        if (!r.ok) return arm(slot);
      }
      host.log({ ev: "slot.reset", slot, why: `${slot}: сброс ${to} — продолжаю` });
      arm(slot);
      resume(slot);
    });
  }

  /** Сообщение лимита из потока сессии слота. */
  function onLimit(s: Session, slot: string, info: Record<string, unknown>): void {
    const type = typeof info.rateLimitType === "string" ? info.rateLimitType : "five_hour";
    const rejected = info.status === "rejected";
    const u = typeof info.utilization === "number" ? info.utilization : rejected ? 1 : undefined;
    const resetsAt = typeof info.resetsAt === "number" ? info.resetsAt : 0;
    const cur = whoIn(slot);
    if (!cur || u === undefined) return;
    const accs = all();
    // имени аккаунта в событии нет: сброс не тот, что у окна аккаунта в слоте, а тот, что у окна другого, —
    // это поздний ответ вызова, ушедшего до подмены
    const mineAt = accs[cur]?.limits?.[type]?.resetsAt;
    const late =
      resetsAt && mineAt !== resetsAt
        ? Object.entries(accs).find(([n, a]) => n !== cur && a.limits?.[type]?.resetsAt === resetsAt)?.[0]
        : undefined;
    const account = late ?? cur;
    merge(account, { [type]: { utilization: u, resetsAt } }, "event", sec());
    if (late) {
      host.log({ ev: "late", slot, callsign: s.info.callsign, why: `${slot}: поздний ответ ${late}` });
      return;
    }
    if (rejected) {
      // отказал именно этот аккаунт: ошибка хода придёт уже после подмены — виновник записан здесь
      s.store<Mine>().update((x) => ({ slot, ...x, cut: x?.cut || cur }));
      void swap(slot, cur, "отказ");
    } else if (u >= limitOf(type)) void swap(slot, cur, `${winName(type)} ${pct(u)}`);
  }

  function onEvent(s: Session, msg: SDKMessage): void {
    const slot = slotOf(s);
    if (!slot) return;
    const m = msg as unknown as Record<string, unknown>;
    if (m.type === "rate_limit_event") return onLimit(s, slot, (m.rate_limit_info ?? {}) as Record<string, unknown>);
    if (m.type === "assistant" && m.error === "rate_limit") {
      // ход оборван лимитом: «Продолжай» — после result и подмены
      // виновник — отказавший в событии лимита, если оно было; иначе тот, кто в слоте сейчас
      // (живой прогон 31 окт.: ошибка пришла после подмены third → main и увела слот ещё и с main)
      s.store<Mine>().update((x) => ({ slot, ...x, cut: x?.cut || (whoIn(slot) ?? "") }));
      return;
    }
    if (m.type === "result") {
      const cut = mine(s)?.cut;
      if (cut === undefined) return;
      // отказ пришёл без события лимита: слот всё ещё на том аккаунте — подмена сейчас
      if (cut && whoIn(slot) === cut) void swap(slot, cut, "отказ");
    }
  }

  /** Слот сессии: живой сессии — close() и resume между ходами. */
  function setSlot(s: Session, slot: string | null): boolean {
    const was = slotOf(s);
    s.store<Mine>().set({ slot });
    const live = s.state !== "stopped" && s.state !== "failed";
    if (was === slot || !live) return false;
    void s.restart();
    return true;
  }

  /** Слот существует и в нём кто-то есть; иначе отказ со словом. */
  function usable(slot: string): void {
    if (!order()[slot]) throw refuse("no_slot", `слота ${slot} нет. ${slotsWord()}`);
    if (!whoIn(slot)) throw refuse("not_logged_in", `в слоте ${slot} никого`);
  }

  const requests: Module["requests"] = {
    async "machine.accounts"(f) {
      const maxAge = typeof f.max_age === "number" ? f.max_age : null;
      if (maxAge !== null) await Promise.all(Object.entries(all()).filter(([, a]) => a.login === "ok" && stale(a, maxAge)).map(([name]) => poll(name)));
      const now = sec();
      const accounts: Record<string, unknown> = {};
      for (const [name, a] of Object.entries(all())) accounts[name] = view(a, now);
      const slots: Record<string, unknown> = {};
      for (const [name, list] of Object.entries(order())) {
        slots[name] = { account: whoIn(name), order: list, wait: waitOf(name), sessions: sessionsIn(name).map((s) => s.info.callsign) };
      }
      return { accounts, slots };
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
        r = (await within(p.sdk("claudeAuthenticate", true), `не ответил за ${LOGIN_MS / 1000} с`, LOGIN_MS)) as { manualUrl?: string };
      } catch (e) {
        closeLogin(name);
        throw refuse("login_failed", `${name}: claudeAuthenticate — ${(e as Error).message}`);
      }
      const url = r.manualUrl ?? "";
      logins.set(name, { p, state: new URL(url, "https://claude.ai").searchParams.get("state") });
      save(name, (cur) => ({ ...(cur ?? { limits: {} }), login: "pending" }));
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
        r = (await within(l.p.sdk("claudeOAuthCallback", code, state), `не ответил за ${LOGIN_MS / 1000} с`, LOGIN_MS)) as typeof r;
      } catch (e) {
        closeLogin(name);
        save(name, (cur) => cur && { ...cur, login: "none" });
        throw refuse("bad_code", `${name}: claude не принял код — ${(e as Error).message.replaceAll(raw, "…").replaceAll(code, "…")}`);
      }
      let acc = r?.account;
      if (!acc?.email) {
        try {
          acc = ((await within(l.p.sdk("accountInfo"), `не ответил за ${LOGIN_MS / 1000} с`, LOGIN_MS)) as typeof acc) ?? acc;
        } catch (e) {
          host.log({ kind: "refuse", ev: "login", account: name, why: `${name}: accountInfo — ${(e as Error).message}` });
        }
      }
      closeLogin(name);
      let ok = false;
      if (all()[name]) {
        try {
          ok = await loggedIn(name);
        } catch (e) {
          host.log({ kind: "refuse", ev: "login", account: name, why: (e as Error).message });
        }
      }
      save(name, (cur) => ({
        ...(cur ?? { limits: {} }),
        login: ok ? "ok" : "none",
        checked: sec(),
        ...(acc?.email ? { email: acc.email } : {}),
        ...(acc?.subscriptionType ? { plan: acc.subscriptionType } : {}),
      }));
      host.log({ ev: "login", account: name, why: ok ? `${name}: вошёл` : `${name}: claude принял код, но auth status — не вошёл` });
      return { email: acc?.email ?? null, plan: acc?.subscriptionType ?? null };
    },

    /**
     * Удалить аккаунт одним запросом: окна кандидатов опрошены один раз разом, все слоты проверены до первой правки,
     * ссылки перевешены, порядок поправлен, папка стёрта, запись удалена. Предел — опрос плюс блокировка входа на слот.
     */
    "machine.account_remove"(f, ctx: Ctx) {
      return queue(async () => {
        const [name] = need(f);
        const next = typeof f.next === "string" && f.next ? f.next : null;
        const inSlots = Object.keys(order()).filter((s) => whoIn(s) === name);
        const others = [...new Set(inSlots.flatMap((s) => order()[s]))].filter((n) => n !== name && all()[n]?.login === "ok" && stale(all()[n], FRESH_S));
        await Promise.all(others.map((n) => poll(n)));
        const plan: Array<[string, string]> = [];
        for (const slot of inSlots) {
          const to = next && order()[slot].includes(next) ? next : candidate(slot, sec(), name);
          if (!to) throw refuse("no_reserve", `слот ${slot}: в запасе нет вошедшего аккаунта ниже порога`);
          if (all()[to]?.login !== "ok" || !existsSync(join(dirOf(to), CREDENTIALS))) throw refuse("not_logged_in", `слот ${slot}: у ${to} входа нет`);
          plan.push([slot, to]);
        }
        for (const [slot, to] of plan) {
          if (stopping || ctx.signal?.aborted) throw refuse("shutting_down", `${name}: Host останавливается, слот ${slot} не сменён — повторите запрос`);
          const r = await place(slot, to, "удаление аккаунта", ctx.from);
          if (!r.ok) throw refuse(r.error, `слот ${slot}: ${r.why ?? r.error}`);
          arm(slot);
          resume(slot);
        }
        for (const [slot, list] of Object.entries(order())) {
          if (list.includes(name)) setOrder(slot, list.filter((x) => x !== name));
        }
        closeLogin(name);
        for (const p of polls.get(name) ?? []) p.close();
        // только своя папка аккаунта; claude auth logout не зовём — он чистит общие настройки
        try {
          rmSync(dirOf(name), { recursive: true, force: true });
        } catch (e) {
          throw refuse("account_dir_busy", `${name}: папка аккаунта занята — ${(e as Error).message}; повторите запрос`);
        }
        save(name, () => undefined);
        host.log({ ev: "account_remove", account: name, why: `${name}: папка аккаунта удалена` });
        return { wiped: true };
      });
    },

    "slot.set"(f) {
      const slot = f.slot;
      if (typeof slot !== "string" || !SLOT.test(slot)) throw refuse("bad_frame", "имя слота — латиница, цифры, - и _");
      const list = Array.isArray(f.order) ? (f.order as unknown[]).map(String) : [];
      return queue(async () => {
        for (const n of list) if (!all()[n]) throw refuse("no_account", `${n}: такого аккаунта на машине нет`);
        const known = order()[slot];
        if (!list.length) {
          if (!known) throw refuse("no_slot", `слота ${slot} нет. ${slotsWord()}`);
          if (sessionsIn(slot).length) throw refuse("has_sessions", `в слоте ${slot} есть сессии`);
          await link(slot, null);
          setOrder(slot, null);
          host.log({ ev: "slot.set", slot, why: `слот ${slot} удалён` });
          return { account: null };
        }
        let cur = whoIn(slot);
        if (!cur) {
          // новый слот берёт первый вошедший аккаунт порядка (хоть и стоящий в другом слоте); такого нет — слота нет:
          // сессии в слоте без входа шли бы «Not logged in» (живой прогон 31 окт.)
          const first = list.find((n) => all()[n]?.login === "ok");
          if (!first) throw refuse("no_reserve", `${slot}: в порядке нет вошедшего аккаунта`);
          setOrder(slot, list);
          const r = await place(slot, first, "новый слот");
          if (!r.ok) {
            if (!known) setOrder(slot, null);
            throw refuse(r.error, `${slot}: ${first} не встал в слот — ${r.why ?? r.error}`);
          }
          cur = first;
        } else setOrder(slot, list);
        host.log({ ev: "slot.set", slot, order: list });
        arm(slot);
        return { account: cur };
      });
    },

    "slot.swap"(f, ctx: Ctx) {
      const slot = String(f.slot ?? "");
      if (!order()[slot]) throw refuse("no_slot", `слота ${slot} нет. ${slotsWord()}`);
      return queue(async () => {
        let to = typeof f.account === "string" ? f.account : null;
        if (to && !all()[to]) throw refuse("no_account", `${to}: такого аккаунта на машине нет`);
        to ??= candidate(slot, sec());
        if (!to) throw refuse("no_reserve", `${slot}: в запасе нет вошедшего аккаунта ниже порога`);
        const r = await place(slot, to, "вручную", ctx.from);
        if (!r.ok) throw refuse(r.error, `${slot}: ${r.why ?? r.error}`);
        arm(slot);
        resume(slot);
        return { from: r.from, to };
      });
    },

    "session.slot"(f, ctx: Ctx) {
      const callsign = String(f.callsign ?? "");
      if (f.slot !== null && typeof f.slot !== "string") throw refuse("bad_frame", "session.slot: нужно поле slot — имя слота или null");
      const slot = f.slot;
      if (slot !== null) usable(slot);
      const s = ctx.host.session(callsign);
      if (!s) throw refuse("offline", `сессии ${callsign} нет на машине`);
      return { restart: setSlot(s, slot) };
    },
  };

  const mod = {
    requests,
    fields: {
      slot: (s: Session) => {
        const slot = slotOf(s);
        return slot ? { name: slot, wait: waitOf(slot) } : undefined;
      },
      account: (s: Session) => {
        const slot = slotOf(s);
        return slot ? whoIn(slot) : undefined;
      },
    },
    /** Открытие сессии: названный слот или правило машины: нет слотов — без слота, один — он, больше — отказ со списком. */
    opening(s: Session, req: Record<string, unknown>): void {
      if (req.slot !== undefined && typeof req.slot !== "string") throw refuse("bad_frame", "session.open: slot — имя слота");
      let slot: string | null;
      if (typeof req.slot === "string") slot = req.slot;
      else {
        const names = Object.keys(order());
        if (names.length > 1) throw refuse("slot_required", slotsWord());
        slot = names[0] ?? null;
      }
      if (slot !== null) usable(slot);
      s.store<Mine>().set({ slot });
    },
    session(s: Session) {
      const slot = slotOf(s);
      if (!slot) return undefined;
      // папку не создаём: на её месте — ссылка; слота без аккаунта не бывает (slot.set)
      return { env: { CLAUDE_SECURESTORAGE_CONFIG_DIR: slotDir(slot) } };
    },
    on: {
      event: onEvent,
      state(s: Session, st: SessionState) {
        // ход оборван, а подмена уже прошла раньше result: «Продолжай» на свободной сессии
        const slot = slotOf(s);
        if (slot && st === "idle" && mine(s)?.cut !== undefined && !timers.has(slot) && whoIn(slot) !== mine(s)?.cut) void queue(async () => resume(slot));
      },
    },
    start(h: Host) {
      host = h;
      // перенос — до первого обращения к хранилищу: у него свой кэш
      if (migrate(join(h.dataDir, "store"))) host.log({ ev: "migrate", why: "записи аккаунтов и слотов перенесены в один файл, прежние файлы рядом" });
      // процесс входа умер вместе с прежним Host
      for (const [name, a] of Object.entries(all())) if (a.login === "pending") save(name, (cur) => cur && { ...cur, login: "none" });
      timer = setInterval(() => void check().catch((e) => host.log({ kind: "refuse", ev: "check", why: (e as Error).message })), CHECK_MS);
      for (const slot of Object.keys(order())) arm(slot);
    },
    stop() {
      stopping = true;
      if (timer) clearInterval(timer);
      timer = null;
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      for (const name of [...logins.keys()]) closeLogin(name);
      for (const set of polls.values()) for (const p of set) p.close();
    },
  };
  return mod as unknown as Module & Required<Pick<Module, "requests">> & { opening(s: Session, req: Record<string, unknown>): void };
}
