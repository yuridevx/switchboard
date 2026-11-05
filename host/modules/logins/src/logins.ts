// Аккаунты Claude на машине и слоты. Все изменения слотов идут одной очередью: решение принимается внутри неё и видит то, что есть сейчас.
// Кто в слоте — ссылка на диске; ждёт ли слот — считается из окон; копий нет. Имя аккаунта — его почта. Каждый процесс Claude получает обе папки явно.
import type { Host, Module, SDKMessage, Session } from "@switchboard/host";
import { isRefusal, refuse } from "@switchboard/host";
import { READ_MS, within } from "@switchboard/protocol";
import { rmSync } from "node:fs";
import type { Account } from "./limits.ts";
import { nextUp, over, shown, stale, usable, usableAt } from "./limits.ts";
import { envOf, folders, type Folders } from "./links.ts";
import { signin, type SignedIn } from "./signin.ts";

type Book = { accounts: Record<string, Account>; slots: Record<string, string[]> };
/** Запись сессии: её слот и аккаунт, на котором оборвался ход. */
type Seat = { slot: string; cut?: string };

const USAGE = "usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET";
const NAME = /^[A-Za-z0-9_-]+$/;
/** Окна запасного старше этого — спросить у Claude: расход на других машинах видно только там. */
const FRESH_S = 120;
const POLL_MS = READ_MS - 2_000;
/** Один аккаунт на разных машинах: 17:59:59 и 18:00:00 (замер 5 нояб.). */
const RESET_DRIFT_S = 2;
/** Слот, который заводит вход на машине без слотов. */
const MAIN = "main";
const CONTINUE = "Продолжай";
const WINDOW_NAMES: Record<string, string> = { five_hour: "5 ч", seven_day: "нед." };

const now = () => Math.floor(Date.now() / 1000);
const clock = (t: number) => new Date(t * 1000).toTimeString().slice(0, 5);
const say = (e: unknown) => (e as Error).message;

export function make(): Module {
  let host: Host;
  let dirs: Folders;
  let stopping = false;
  let wake: ReturnType<typeof setTimeout> | undefined;
  /** Слоты, которые ждали при последнем расчёте: их проверяет побудка. */
  let waiting: string[] = [];
  let tail: Promise<unknown> = Promise.resolve();
  const polls = new Set<{ close(): void }>();
  let auth: ReturnType<typeof signin>;

  const shelf = () => host.store<Book>();
  const book = () => shelf().get() ?? { accounts: {}, slots: {} };
  const write = (fn: (b: Book) => void) => void shelf().update((b = { accounts: {}, slots: {} }) => (fn(b), b));
  const seatOf = (s: Session) => s.store<Seat>();

  /** Изменения слотов — по очереди. */
  function serial<T>(work: () => T | Promise<T>): Promise<T> {
    const run = tail.then(() => {
      if (stopping) throw refuse("shutting_down", "Host останавливается, слот не сменён — повторите запрос");
      return work();
    });
    tail = run.catch(() => {});
    return run;
  }

  /** Работа без спроса: отказ уже в журнале у того, кто отказал. */
  const background = (work: () => Promise<void>) =>
    void serial(work).catch((e) => {
      if (!isRefusal(e)) throw e;
    });

  const inSlot = (slot: string) => dirs.inSlot(slot);
  const seated = (slot: string) => host.sessions().map((x) => host.session(x.callsign)!).filter((s) => seatOf(s).get()?.slot === slot);

  /** Слот ждёт сброса: в нём аккаунт у порога и запаса нет. */
  function waitOf(slot: string): number | null {
    const { accounts, slots } = book();
    const cur = inSlot(slot);
    const t = now();
    if (!cur || !accounts[cur] || usable(accounts[cur], t) || nextUp(slots[slot] ?? [], accounts, t, cur)) return null;
    const times = (slots[slot] ?? []).filter((n) => accounts[n]?.login === "ok").map((n) => usableAt(accounts[n], t)).filter(Boolean);
    return times.length ? Math.min(...times) : null;
  }

  /** Побудка на ближайший сброс. */
  function plan(): void {
    clearTimeout(wake);
    wake = undefined;
    if (stopping) return;
    waiting = Object.keys(book().slots).filter((s) => waitOf(s));
    if (!waiting.length) return;
    const first = Math.min(...waiting.map((s) => waitOf(s)!));
    wake = setTimeout(() => background(reset), Math.max(0, first * 1000 - Date.now()));
  }

  const listing = () => {
    const names = Object.keys(book().slots);
    return names.length ? `Слоты машины: ${names.map((s) => (waitOf(s) ? `${s} (ждёт сброса ${clock(waitOf(s)!)})` : s)).join(", ")}` : "На машине нет слотов";
  };
  const noSlot = (slot: string) => refuse("no_slot", `слота ${slot} нет. ${listing()}`);

  /** Единственная смена аккаунта слота: ссылка, поля сессий, журнал машины и флота. Журнал флота не ответил — причину пишет ядро. */
  async function put(slot: string, to: string, why: string, by?: string): Promise<void> {
    const from = inSlot(slot);
    try {
      await dirs.place(slot, to);
    } catch (e) {
      if (isRefusal(e)) host.log({ kind: "refuse", ev: "slot.swap", word: e.word, why: `${slot}: подмена на ${to} — ${e.word}${e.why ? `: ${e.why}` : ""}` });
      throw e;
    }
    for (const s of seated(slot)) s.refresh();
    const text = `слот ${slot}: ${from ?? "—"} → ${to} · ${why}`;
    host.log({ ev: "place", account: to, dir: dirs.slotDir(slot), from, why: text });
    host.emit({ type: "ledger.add", to: ".ledger", ev: "slot.swapped", machine: host.machine, text, ...(by ? { by } : {}) });
  }

  /** Сессия с оборвавшимся ходом продолжает, когда свободна; тот же аккаунт — только после его сброса. */
  function resume(s: Session, sameToo = false): void {
    const seat = seatOf(s).get();
    if (!seat?.cut || !seat.slot || s.state !== "idle") return;
    if (seat.cut === inSlot(seat.slot) && !sameToo) return;
    seatOf(s).set({ slot: seat.slot });
    s.input(CONTINUE);
  }

  /** После смены слота: поля, побудка, оборванные. */
  function settled(slot: string, sameToo = false): void {
    for (const s of seated(slot)) {
      s.refresh();
      resume(s, sameToo);
    }
    plan();
  }

  async function poll(name: string): Promise<void> {
    if (stopping) return;
    const probe = host.probe({ env: envOf(dirs.accDir(name)) });
    polls.add(probe);
    try {
      const u = (await within(probe.sdk(USAGE, { skipBehaviors: true }), `не ответил за ${POLL_MS / 1000} с`, POLL_MS)) as { rate_limits?: Record<string, { utilization?: number | null; resets_at?: string | null } | null> | null };
      const at = now();
      write((b) => {
        const a = b.accounts[name];
        if (!a) return;
        // неактивное окно приходит null, а в extra_usage utilization — null (живой ответ 5 нояб.)
        for (const [w, v] of Object.entries(u.rate_limits ?? {})) if (typeof v?.utilization === "number") a.limits[w] = { utilization: v.utilization / 100, resetsAt: v.resets_at ? Math.floor(Date.parse(v.resets_at) / 1000) : 0, at };
      });
    } catch (e) {
      host.log({ kind: "refuse", ev: "poll", why: `${name}: опрос лимитов — ${say(e)}` });
    } finally {
      polls.delete(probe);
      probe.close();
    }
  }

  /** Кого положить в слот: по порядку, окна свежие у Claude; у порога — следующий. */
  async function reserve(slot: string, from: string | null): Promise<string | null> {
    for (const name of book().slots[slot] ?? []) {
      if (name === from || !usable(book().accounts[name], now())) continue;
      if (stale(book().accounts[name], FRESH_S, now())) await poll(name);
      if (usable(book().accounts[name], now())) return name;
    }
    return null;
  }

  /** Подмена без человека: порог или отказ модели; слот успел смениться — ничего. */
  function swapFrom(slot: string, from: string, why: string): void {
    background(async () => {
      if (inSlot(slot) !== from) return;
      const to = await reserve(slot, from);
      if (!to) {
        const w = waitOf(slot);
        host.log({ ev: "slot.wait", why: `${slot}: все аккаунты у порога — жду сброса${w ? ` ${clock(w)}` : ""}` });
        return settled(slot);
      }
      try {
        await put(slot, to, why);
      } finally {
        settled(slot);
      }
    });
  }

  /** Вход перестал быть годным: каждый слот, где стоит аккаунт, идёт на следующего. */
  function lost(email: string): void {
    for (const slot of Object.keys(book().slots)) if (inSlot(slot) === email) swapFrom(slot, email, "вход пропал");
    plan();
  }

  /** Почта нового входа известна: файл на место, запись; на машине без слотов — слот main. */
  function landed(email: string, info: SignedIn): Promise<void> {
    return serial(async () => {
      await dirs.settle(email);
      write((b) => void (b.accounts[email] = { ...(b.accounts[email] ?? { limits: {} }), ...info, login: "ok" }));
      if (!Object.keys(book().slots).length) {
        await put(MAIN, email, "новый слот");
        write((b) => void (b.slots[MAIN] = [email]));
        host.log({ ev: "slot.set", why: `${MAIN}: первый вход на машине без слотов` });
      }
      plan();
    });
  }

  /** Час сброса: аккаунт слота снова годен или в запасе появился годный. */
  async function reset(): Promise<void> {
    for (const slot of waiting) {
      try {
        const cur = inSlot(slot);
        if (cur && usable(book().accounts[cur], now())) {
          host.log({ ev: "slot.reset", why: `${slot}: сброс ${cur} — продолжаю` });
          settled(slot, true);
          continue;
        }
        const to = await reserve(slot, cur);
        if (!to) continue;
        await put(slot, to, "сброс");
        host.log({ ev: "slot.reset", why: `${slot}: сброс ${to} — продолжаю` });
        settled(slot);
      } catch (e) {
        // отказ одного слота не трогает остальные; причина уже в журнале у того, кто отказал
        if (!isRefusal(e)) throw e;
      }
    }
    plan();
  }

  /** Окно из сообщения сессии. Сброс совпал с окном другого аккаунта порядка — это поздний ответ прежнего. */
  function limitEvent(s: Session, slot: string, info: { status?: string; rateLimitType?: string; utilization?: number; resetsAt?: number }): void {
    const cur = inSlot(slot);
    const type = info.rateLimitType;
    if (!cur || !type) return;
    const rejected = info.status === "rejected";
    const utilization = rejected ? 1 : info.utilization;
    if (utilization === undefined) return;
    const resetsAt = info.resetsAt ?? 0;
    const { accounts, slots } = book();
    const same = (n: string) => {
      const known = accounts[n]?.limits[type]?.resetsAt;
      return known !== undefined && Math.abs(known - resetsAt) <= RESET_DRIFT_S;
    };
    const owner = same(cur) ? cur : ((slots[slot] ?? []).find((n) => n !== cur && same(n)) ?? cur);
    const at = now();
    write((b) => {
      const a = b.accounts[owner];
      if (a && !((a.limits[type]?.at ?? 0) > at)) a.limits[type] = { utilization, resetsAt, at };
    });
    if (owner !== cur) {
      host.log({ ev: "late", callsign: s.info.callsign, why: `${slot}: поздний ответ ${owner}` });
      return plan();
    }
    if (rejected) seatOf(s).update((x) => (x ? { ...x, cut: cur } : x));
    const a = book().accounts[cur];
    if (rejected) swapFrom(slot, cur, "отказ");
    else if (a && over(a, at)) swapFrom(slot, cur, `${WINDOW_NAMES[type] ?? type} ${Math.round(utilization * 100)} %`);
    plan();
  }

  function onEvent(s: Session, m: SDKMessage): void {
    const seat = seatOf(s).get();
    if (!seat?.slot) return;
    const msg = m as { type: string; error?: string; rate_limit_info?: Parameters<typeof limitEvent>[2] };
    if (msg.type === "rate_limit_event" && msg.rate_limit_info) limitEvent(s, seat.slot, msg.rate_limit_info);
    if (msg.type === "assistant" && msg.error === "rate_limit" && !seat.cut) seatOf(s).set({ ...seat, cut: inSlot(seat.slot) ?? undefined });
    const cut = seatOf(s).get()?.cut;
    // отказ без события лимита: подмена на конце хода
    if (msg.type === "result" && cut && cut === inSlot(seat.slot)) swapFrom(seat.slot, cut, "отказ");
  }

  /** Сессия идёт только в слоте; какой — решается ещё до запуска. */
  async function opening(s: Session, req: Record<string, unknown>): Promise<void> {
    const names = Object.keys(book().slots);
    let slot: string;
    if ("slot" in req) {
      if (typeof req.slot !== "string") throw refuse("bad_frame", "session.open: slot — имя слота");
      if (!names.includes(req.slot)) throw noSlot(req.slot);
      slot = req.slot;
    } else if (names.length > 1) {
      throw refuse("slot_required", listing());
    } else if (!names.length) {
      throw refuse("no_slot", `на ${host.machine} нет слотов: войдите в аккаунт или создайте слот`);
    } else {
      slot = names[0];
    }
    assertLogin(slot);
    seatOf(s).set({ slot });
  }

  function assertLogin(slot: string): void {
    const cur = inSlot(slot);
    if (!cur) throw refuse("not_logged_in", `в слоте ${slot} нет аккаунта`);
    if (book().accounts[cur]?.login !== "ok") throw refuse("not_logged_in", `в слоте ${slot} ${cur} без входа`);
  }

  async function slotSet(slot: string, order: string[]): Promise<{ account: string | null }> {
    if (!NAME.test(slot)) throw refuse("bad_frame", "имя слота — латиница, цифры, - и _");
    const { accounts, slots } = book();
    if (!order.length) {
      if (!slots[slot]) throw noSlot(slot);
      if (seated(slot).length) throw refuse("has_sessions", `${slot}: в слоте есть сессии`);
      await dirs.unplace(slot);
      write((b) => void delete b.slots[slot]);
      plan();
      return { account: null };
    }
    const ghost = order.find((n) => !accounts[n]);
    if (ghost) throw refuse("no_account", `${ghost}: такого аккаунта на машине нет`);
    let account = inSlot(slot);
    if (!account) {
      account = order.find((n) => accounts[n].login === "ok") ?? null;
      if (!account) throw refuse("no_reserve", `${slot}: в порядке нет вошедшего аккаунта`);
      await put(slot, account, "новый слот");
    }
    write((b) => void (b.slots[slot] = order));
    settled(slot);
    return { account };
  }

  async function slotSwap(slot: string, named: string | undefined, by: string | undefined): Promise<{ from: string | null; to: string }> {
    if (!book().slots[slot]) throw noSlot(slot);
    const from = inSlot(slot);
    if (named !== undefined) {
      if (!book().accounts[named]) throw refuse("no_account", `${named}: такого аккаунта на машине нет`);
      if (book().accounts[named].login !== "ok") throw refuse("not_logged_in", `слот ${slot}: у ${named} входа нет`);
    }
    const to = named ?? (await reserve(slot, from));
    if (!to) throw refuse("no_reserve", `${slot}: в запасе нет вошедшего аккаунта ниже порога`);
    if (to === from) return { from, to };
    await put(slot, to, "вручную", by);
    settled(slot);
    return { from, to };
  }

  /** Удаление одним запросом: сначала видно, что всем слотам есть кого положить, потом шаги. */
  async function accountRemove(name: string, by: string | undefined): Promise<{ wiped: boolean }> {
    if (!book().accounts[name]) throw refuse("no_account", `аккаунта ${name} на машине нет`);
    const holding = Object.keys(book().slots).filter((s) => inSlot(s) === name);
    const plans: Array<[string, string]> = [];
    for (const slot of holding) {
      const to = await reserve(slot, name);
      if (!to) throw refuse("no_reserve", `${slot}: в запасе нет вошедшего аккаунта ниже порога; поставьте другой аккаунт или удалите слот без сессий`);
      plans.push([slot, to]);
    }
    for (const [slot, to] of plans) await put(slot, to, "удаление аккаунта", by);
    write((b) => {
      for (const s of Object.keys(b.slots)) b.slots[s] = b.slots[s].filter((n) => n !== name);
      for (const [s, to] of plans) if (!b.slots[s].includes(to)) b.slots[s].push(to);
    });
    for (const [slot] of plans) settled(slot);
    try {
      rmSync(dirs.accDir(name), { recursive: true, force: true });
    } catch (e) {
      throw refuse("account_dir_busy", `${name}: папка аккаунта занята — ${say(e)}`);
    }
    write((b) => void delete b.accounts[name]);
    host.log({ ev: "account_remove", why: `${name}: аккаунт удалён` });
    return { wiped: true };
  }

  function view() {
    const { accounts, slots } = book();
    const t = now();
    return {
      accounts: Object.fromEntries(Object.entries(accounts).map(([n, a]) => [n, shown(a, t)])),
      slots: Object.fromEntries(Object.entries(slots).map(([s, order]) => [s, { account: inSlot(s), order, wait: waitOf(s) }])),
    };
  }

  return {
    opening,
    session(s) {
      const slot = seatOf(s).get()?.slot;
      return slot ? { env: { CLAUDE_SECURESTORAGE_CONFIG_DIR: dirs.slotDir(slot) } } : undefined;
    },
    fields: {
      slot(s) {
        const slot = seatOf(s).get()?.slot;
        return slot ? { name: slot, wait: waitOf(slot) } : undefined;
      },
      account(s) {
        const slot = seatOf(s).get()?.slot;
        return slot ? (inSlot(slot) ?? undefined) : undefined;
      },
    },
    on: {
      event: onEvent,
      state(s, state) {
        if (state === "idle") resume(s);
      },
    },
    requests: {
      async "machine.accounts"(req) {
        const asked = Array.isArray(req.poll) ? (req.poll as unknown[]).map(String) : [];
        await Promise.all(asked.filter((n) => book().accounts[n]?.login === "ok").map((n) => poll(n)));
        return view();
      },
      "machine.login": () => auth.login(),
      "machine.login_code": (req) => auth.code(String(req.code)),
      "machine.account_remove": (req, ctx) => serial(() => accountRemove(String(req.account), ctx.from)),
      "slot.set": (req) => serial(() => slotSet(String(req.slot), (req.order ?? []) as string[])),
      "slot.swap": (req, ctx) => serial(() => slotSwap(String(req.slot), req.account as string | undefined, ctx.from)),
      "session.slot"(req) {
        const s = host.session(req.callsign as string)!;
        const slot = req.slot;
        if (typeof slot !== "string") throw refuse("bad_frame", "session.slot: нужно поле slot — имя слота");
        if (!book().slots[slot]) throw noSlot(slot);
        assertLogin(slot);
        if (seatOf(s).get()?.slot === slot) return { restart: false };
        seatOf(s).set({ slot });
        if (s.state === "stopped" || s.state === "failed") return { restart: false };
        void s.restart();
        return { restart: true };
      },
    },
    start(h) {
      host = h;
      dirs = folders(h.dataDir);
      auth = signin(() => host, dirs, {
        read: () => book().accounts,
        edit(email, patch) {
          write((b) => void (b.accounts[email] = { ...b.accounts[email], ...patch }));
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
