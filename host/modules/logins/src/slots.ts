// Слоты: кто стоит в слоте, подмена у порога и отказа, ожидание сброса, «Продолжай» оборванным ходам.
// Подмены, правки порядка и удаление аккаунта идут одной очередью. Процессы сессий не трогаются: они читают вход через ссылку.
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { isRefusal, refuse } from "@switchboard/host";
import type { Ctx, Frame, Host, Module, SDKMessage, Session, SessionState } from "@switchboard/host";
import { limitOf, nextUp, over, stale, usableAt } from "./limits.ts";
import { CREDENTIALS, exists, link, targetOf, underRefreshLock, unlink } from "./links.ts";
import { sec, type Book } from "./book.ts";
import type { Usage } from "./usage.ts";

/** Раздел сессии: слот и «ход оборван лимитом» — на каком аккаунте. */
type Mine = { slot: string | null; cut?: string };

/** Окна моложе двух минут — свежие: то же, что спрашивает страница аккаунтов (max_age 120). */
const FRESH_S = 120;
const CONTINUE = "Продолжай";
/** Слот, который машина без слотов и без общего входа заводит сама при открытии сессии. */
const MAIN_SLOT = "main";
const SLOT = /^[A-Za-z0-9_-]+$/;

const hhmm = (t: number) => new Date(t * 1000).toTimeString().slice(0, 5);
const windowWord = (w: string) => (w === "five_hour" ? "5 ч" : w === "seven_day" ? "нед." : w);

export function makeSlots(host: () => Host, book: Book, usage: Usage, sharedLogin: () => Promise<boolean>) {
  let stopping = false;
  let chain: Promise<unknown> = Promise.resolve();
  /** таймер ожидания сброса слота */
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  function queue<T>(fn: () => Promise<T>): Promise<T> {
    const p = chain.then(fn, fn);
    chain = p.catch(() => undefined);
    return p;
  }

  const mine = (s: Session) => s.store<Mine>().get();
  const slotOf = (s: Session) => mine(s)?.slot ?? null;
  const live = (s: Session) => s.state !== "stopped" && s.state !== "failed";

  /** Кто в слоте: цель ссылки, если её папка есть и у неё есть запись аккаунта. */
  function whoIn(slot: string): string | null {
    const target = targetOf(book.slotDir(slot));
    if (!target || !existsSync(target)) return null;
    return Object.keys(book.accounts()).find((n) => resolve(book.accountDir(n)) === target) ?? null;
  }

  const sessionsIn = (slot: string): Session[] =>
    host()
      .sessions()
      .map((x) => host().session(x.callsign))
      .filter((s): s is Session => !!s && slotOf(s) === slot);

  const nextOf = (slot: string, skip: string | null = whoIn(slot)) => nextUp(book.orders()[slot] ?? [], book.accounts(), sec(), skip);

  /** Час сброса, которого слот ждёт: в слоте аккаунт у порога и запаса нет. Считается, не хранится. */
  function waitOf(slot: string): number | null {
    const now = sec();
    const cur = whoIn(slot);
    const all = book.accounts();
    if (!cur || !over(all[cur], now) || nextOf(slot, cur)) return null;
    const times = [cur, ...(book.orders()[slot] ?? [])]
      .filter((n) => all[n]?.login === "ok")
      .map((n) => usableAt(all[n], now))
      .filter((t) => t > now);
    return times.length ? Math.min(...times) : null;
  }

  function arm(slot: string): void {
    const t = timers.get(slot);
    if (t) clearTimeout(t);
    timers.delete(slot);
    const w = waitOf(slot);
    if (w !== null) timers.set(slot, setTimeout(() => void onReset(slot), Math.max(0, w * 1000 - Date.now())));
  }

  /** Слоты машины для причины отказа: кто ждёт сброса — с часом. */
  function slotsWord(): string {
    const names = Object.keys(book.orders());
    if (!names.length) return "На машине нет слотов";
    const word = (n: string) => {
      const w = waitOf(n);
      return w ? `${n} (ждёт сброса ${hhmm(w)})` : n;
    };
    return `Слоты машины: ${names.map(word).join(", ")}`;
  }

  /** Перевесить или снять ссылку. Ответ — прежний аккаунт; отказ — словом. */
  async function relink(slot: string, to: string | null): Promise<string | null> {
    if (to !== null) {
      const a = book.accounts()[to];
      if (!a) throw refuse("no_account", `аккаунта ${to} на машине нет`);
      if (a.login !== "ok" || !existsSync(join(book.accountDir(to), CREDENTIALS))) throw refuse("not_logged_in", `${to}: входа нет`);
    }
    const from = whoIn(slot);
    const dir = book.slotDir(slot);
    if (from === to && (to !== null || !exists(dir))) return from;
    const move = () => (to ? link(dir, book.accountDir(to)) : unlink(dir));
    // claude сессий слота обновляет вход в папке прежнего аккаунта — перевешиваем, пока она не занята
    if (from) await underRefreshLock(book.accountDir(from), move);
    else move();
    host().log({ ev: "place", account: to, dir, from });
    return from;
  }

  /** Подмена: ссылка, roster, журнал машины и флота. Отказ — словом и строкой журнала. */
  async function place(slot: string, to: string, why: string, by?: string): Promise<string | null> {
    let from: string | null;
    try {
      from = await relink(slot, to);
    } catch (e) {
      if (isRefusal(e)) host().log({ kind: "refuse", ev: "slot.swap", word: e.word, slot, why: `${slot}: подмена на ${to} — ${e.word}${e.why ? `: ${e.why}` : ""}` });
      throw e;
    }
    // поле account в roster — сразу, а не со следующим событием сессии (живой прогон 31 окт.)
    for (const s of sessionsIn(slot)) s.refresh();
    const text = `слот ${slot}: ${from ?? "—"} → ${to} · ${why}`;
    host().log({ ev: "slot.swapped", slot, from, to, why: text });
    const sent = host().emit({ type: "ledger.add", to: ".ledger", ev: "slot.swapped", machine: host().machine, text, ...(by ? { by } : {}) });
    if (!sent.ok) host().log({ kind: "refuse", ev: "ledger.add", word: sent.error, why: `ledger.add не ушёл: ${sent.error}` });
    return from;
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

  /** Следующий с учётом расхода на других машинах: он виден только у Claude, окна кандидата — свежие. */
  async function freshNext(slot: string): Promise<string | null> {
    for (let i = 0; i < (book.orders()[slot]?.length ?? 0); i++) {
      const n = nextOf(slot);
      if (!n) return null;
      if (stale(book.accounts()[n], FRESH_S, sec())) await usage.poll(n);
      if (!over(book.accounts()[n], sec())) return n;
    }
    return null;
  }

  /** Подмена по порогу или отказу. expect — аккаунт, о котором сигнал: слот уже сменился — второй раз не меняем. */
  function swap(slot: string, expect: string, why: string): Promise<void> {
    return queue(async () => {
      if (stopping || whoIn(slot) !== expect) return;
      const next = await freshNext(slot);
      if (!next) {
        const w = waitOf(slot);
        arm(slot);
        if (w) host().log({ ev: "slot.wait", slot, why: `${slot}: все аккаунты у порога — жду сброса ${hhmm(w)}` });
        return;
      }
      try {
        await place(slot, next, why);
      } catch (e) {
        if (!isRefusal(e)) throw e;
        arm(slot);
        return;
      }
      arm(slot);
      resume(slot);
    });
  }

  /** Час сброса настал: свой аккаунт снова годен или подмена на годный, затем «Продолжай». */
  function onReset(slot: string): Promise<void> {
    timers.delete(slot);
    return queue(async () => {
      if (stopping) return;
      const cur = whoIn(slot);
      const to = cur && !over(book.accounts()[cur], sec()) ? cur : nextOf(slot);
      if (!to) return arm(slot);
      if (to !== cur) {
        try {
          await place(slot, to, "сброс");
        } catch (e) {
          if (!isRefusal(e)) throw e;
          return arm(slot);
        }
      }
      host().log({ ev: "slot.reset", slot, why: `${slot}: сброс ${to} — продолжаю` });
      arm(slot);
      resume(slot);
    });
  }

  /** Ход оборван лимитом. Виновник — отказавший в событии лимита, если оно было: ошибка хода приходит и после подмены. */
  const markCut = (s: Session, slot: string, who: string) => s.store<Mine>().update((x) => ({ slot, ...x, cut: x?.cut || who }));

  /** Сообщение лимита из потока сессии слота. */
  function onLimit(s: Session, slot: string, info: Record<string, unknown>): void {
    const window = typeof info.rateLimitType === "string" ? info.rateLimitType : "five_hour";
    const rejected = info.status === "rejected";
    const used = typeof info.utilization === "number" ? info.utilization : rejected ? 1 : undefined;
    const resetsAt = typeof info.resetsAt === "number" ? info.resetsAt : 0;
    const cur = whoIn(slot);
    if (!cur || used === undefined) return;
    const all = book.accounts();
    // имени аккаунта в событии нет: сброс не у окна аккаунта в слоте, а у окна другого — это поздний ответ вызова, ушедшего до подмены
    const late = resetsAt && all[cur]?.limits?.[window]?.resetsAt !== resetsAt ? Object.keys(all).find((n) => n !== cur && all[n].limits?.[window]?.resetsAt === resetsAt) : undefined;
    usage.observe(late ?? cur, { [window]: { utilization: used, resetsAt } }, "event", sec());
    if (late) {
      host().log({ ev: "late", slot, callsign: s.info.callsign, why: `${slot}: поздний ответ ${late}` });
    } else if (rejected) {
      markCut(s, slot, cur);
      void swap(slot, cur, "отказ");
    } else if (used >= limitOf(window)) {
      void swap(slot, cur, `${windowWord(window)} ${Math.round(used * 100)} %`);
    }
  }

  function onEvent(s: Session, msg: SDKMessage): void {
    const slot = slotOf(s);
    if (!slot) return;
    const m = msg as unknown as Record<string, unknown>;
    if (m.type === "rate_limit_event") onLimit(s, slot, (m.rate_limit_info ?? {}) as Record<string, unknown>);
    // живой прогон 31 окт.: ошибка пришла после подмены third → main и увела слот ещё и с main
    else if (m.type === "assistant" && m.error === "rate_limit") markCut(s, slot, whoIn(slot) ?? "");
    else if (m.type === "result") {
      // отказ пришёл без события лимита: слот всё ещё на том аккаунте — подмена сейчас
      const cut = mine(s)?.cut;
      if (cut && whoIn(slot) === cut) void swap(slot, cut, "отказ");
    }
  }

  /** Новый слот: порядок и первый вошедший в ссылке; такого нет — слота нет: сессии в нём шли бы «Not logged in» (живой прогон 31 окт.). */
  async function createSlot(slot: string, list: string[], known: boolean): Promise<string> {
    const first = list.find((n) => book.accounts()[n]?.login === "ok");
    if (!first) throw refuse("no_reserve", `${slot}: в порядке нет вошедшего аккаунта`);
    book.setOrder(slot, list);
    try {
      await place(slot, first, "новый слот");
    } catch (e) {
      if (!isRefusal(e)) throw e;
      if (!known) book.setOrder(slot, null);
      throw refuse(e.word, `${slot}: ${first} не встал в слот — ${e.why ?? e.word}`);
    }
    return first;
  }

  /** Машина без слотов: общий вход — сессия на нём; нет — слот main из вошедших, иначе новая машина отвечала бы «Not logged in» (журнал hz-ex44-win-1, 4 нояб.). */
  async function slotOfBareMachine(): Promise<string | null> {
    if (await sharedLogin()) return null;
    return queue(async () => {
      const made = Object.keys(book.orders())[0]; // параллельное открытие успело раньше
      if (made) return made;
      const all = book.accounts();
      const list = Object.keys(all).filter((n) => all[n].login === "ok");
      if (!list.length) throw refuse("not_logged_in", `на ${host().machine} нет входа Claude: войдите в аккаунт на этой машине`);
      await createSlot(MAIN_SLOT, list, false);
      host().log({ ev: "slot.set", slot: MAIN_SLOT, order: list, why: `${MAIN_SLOT}: общего входа нет, слот из вошедших аккаунтов` });
      arm(MAIN_SLOT);
      return MAIN_SLOT;
    });
  }

  /** Слот существует и в нём кто-то есть; иначе отказ со словом. */
  function usable(slot: string): void {
    if (!book.orders()[slot]) throw refuse("no_slot", `слота ${slot} нет. ${slotsWord()}`);
    if (!whoIn(slot)) throw refuse("not_logged_in", `в слоте ${slot} никого`);
  }

  const requests: Required<Module>["requests"] = {
    "slot.set"(f: Frame) {
      const slot = f.slot;
      if (typeof slot !== "string" || !SLOT.test(slot)) throw refuse("bad_frame", "имя слота — латиница, цифры, - и _");
      const list = Array.isArray(f.order) ? (f.order as unknown[]).map(String) : [];
      return queue(async () => {
        for (const n of list) if (!book.accounts()[n]) throw refuse("no_account", `${n}: такого аккаунта на машине нет`);
        const known = book.orders()[slot];
        if (!list.length) {
          if (!known) throw refuse("no_slot", `слота ${slot} нет. ${slotsWord()}`);
          if (sessionsIn(slot).length) throw refuse("has_sessions", `в слоте ${slot} есть сессии`);
          await relink(slot, null);
          book.setOrder(slot, null);
          host().log({ ev: "slot.set", slot, why: `слот ${slot} удалён` });
          return { account: null };
        }
        // новый слот берёт первый вошедший аккаунт порядка, хоть и стоящий в другом слоте
        let account = whoIn(slot);
        if (account) book.setOrder(slot, list);
        else account = await createSlot(slot, list, !!known);
        host().log({ ev: "slot.set", slot, order: list });
        arm(slot);
        return { account };
      });
    },

    "slot.swap"(f: Frame, ctx: Ctx) {
      const slot = String(f.slot ?? "");
      if (!book.orders()[slot]) throw refuse("no_slot", `слота ${slot} нет. ${slotsWord()}`);
      return queue(async () => {
        const named = typeof f.account === "string" ? f.account : null;
        if (named && !book.accounts()[named]) throw refuse("no_account", `${named}: такого аккаунта на машине нет`);
        const to = named ?? nextOf(slot);
        if (!to) throw refuse("no_reserve", `${slot}: в запасе нет вошедшего аккаунта ниже порога`);
        let from: string | null;
        try {
          from = await place(slot, to, "вручную", ctx.from);
        } catch (e) {
          if (!isRefusal(e)) throw e;
          throw refuse(e.word, `${slot}: ${e.why ?? e.word}`);
        }
        arm(slot);
        resume(slot);
        return { from, to };
      });
    },

    "session.slot"(f: Frame, ctx: Ctx) {
      if (f.slot !== null && typeof f.slot !== "string") throw refuse("bad_frame", "session.slot: нужно поле slot — имя слота или null");
      const slot = f.slot;
      if (slot !== null) usable(slot);
      const callsign = String(f.callsign ?? "");
      const s = ctx.host.session(callsign);
      if (!s) throw refuse("offline", `сессии ${callsign} нет на машине`);
      const was = slotOf(s);
      s.store<Mine>().set({ slot });
      // живой сессии — close() и resume между ходами
      if (was === slot || !live(s)) return { restart: false };
      void s.restart();
      return { restart: true };
    },
  };

  return {
    requests,
    queue,
    whoIn,
    waitOf,
    sessionsOf: (slot: string) => sessionsIn(slot).map((s) => s.info.callsign),
    /**
     * Увести аккаунт из слотов перед удалением: окна кандидатов опрошены один раз разом, все слоты проверены до первой правки,
     * ссылки перевешены, порядок поправлен. Предел — опрос плюс блокировка входа на слот.
     */
    async evacuate(name: string, next: string | null, ctx: Ctx): Promise<void> {
      const orders = book.orders();
      const inSlots = Object.keys(orders).filter((s) => whoIn(s) === name);
      const all = book.accounts();
      const others = [...new Set(inSlots.flatMap((s) => orders[s]))].filter((n) => n !== name && all[n]?.login === "ok" && stale(all[n], FRESH_S, sec()));
      await Promise.all(others.map((n) => usage.poll(n)));
      const plan: Array<[string, string]> = [];
      for (const slot of inSlots) {
        const to = next && orders[slot].includes(next) ? next : nextOf(slot, name);
        if (!to) throw refuse("no_reserve", `слот ${slot}: в запасе нет вошедшего аккаунта ниже порога`);
        if (book.accounts()[to]?.login !== "ok" || !existsSync(join(book.accountDir(to), CREDENTIALS))) throw refuse("not_logged_in", `слот ${slot}: у ${to} входа нет`);
        plan.push([slot, to]);
      }
      for (const [slot, to] of plan) {
        if (stopping || ctx.signal?.aborted) throw refuse("shutting_down", `${name}: Host останавливается, слот ${slot} не сменён — повторите запрос`);
        try {
          await place(slot, to, "удаление аккаунта", ctx.from);
        } catch (e) {
          if (!isRefusal(e)) throw e;
          throw refuse(e.word, `слот ${slot}: ${e.why ?? e.word}`);
        }
        arm(slot);
        resume(slot);
      }
      for (const [slot, list] of Object.entries(book.orders())) if (list.includes(name)) book.setOrder(slot, list.filter((x) => x !== name));
    },
    fields: {
      slot(s: Session) {
        const slot = slotOf(s);
        return slot ? { name: slot, wait: waitOf(slot) } : undefined;
      },
      account(s: Session) {
        const slot = slotOf(s);
        return slot ? whoIn(slot) : undefined;
      },
    },
    /** Открытие: названный слот или правило машины: нет слотов — slotOfBareMachine, один — он, больше — отказ со списком. */
    async opening(s: Session, req: Record<string, unknown>): Promise<void> {
      if (req.slot !== undefined && typeof req.slot !== "string") throw refuse("bad_frame", "session.open: slot — имя слота");
      const names = Object.keys(book.orders());
      if (typeof req.slot !== "string" && names.length > 1) throw refuse("slot_required", slotsWord());
      const slot = typeof req.slot === "string" ? req.slot : (names[0] ?? (await slotOfBareMachine()));
      if (slot !== null) usable(slot);
      s.store<Mine>().set({ slot });
    },
    /** Папку не создаём: на её месте — ссылка; слота без аккаунта не бывает. */
    session(s: Session) {
      const slot = slotOf(s);
      return slot ? { env: { CLAUDE_SECURESTORAGE_CONFIG_DIR: book.slotDir(slot) } } : undefined;
    },
    on: {
      event: onEvent,
      state(s: Session, st: SessionState) {
        // ход оборван, а подмена уже прошла раньше result: «Продолжай» на свободной сессии
        const slot = slotOf(s);
        if (slot && st === "idle" && mine(s)?.cut !== undefined && !timers.has(slot) && whoIn(slot) !== mine(s)?.cut) void queue(async () => resume(slot));
      },
    },
    start() {
      for (const slot of Object.keys(book.orders())) arm(slot);
    },
    stop() {
      stopping = true;
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    },
  };
}
