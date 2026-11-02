// Модуль slots: горячая подмена аккаунта при лимитах. Слот — ссылка по имени (main, bot) на папку аккаунта;
// сессии слота получают её в CLAUDE_SECURESTORAGE_CONFIG_DIR и читают вход перед каждым вызовом модели.
// Аккаунт слота у порога — slots просит accounts перевесить ссылку на следующего из запаса; процессы не трогаются.
// Один аккаунт может стоять в нескольких слотах: лимит у них общий, каждый слот меняет его по своим событиям.
// Своего о входах и окнах slots не хранит: кто в слоте и окна — записи accounts (кэш в памяти — их копия).
import { join, resolve } from "node:path";
import { refuse } from "@switchboard/host";
import type { Host, Module, SDKMessage, Session, SessionState } from "@switchboard/host";

/** Запись аккаунта, как её отдаёт machine.accounts. */
type Win = { utilization: number; resetsAt: number; at?: number; src?: string };
type Acc = { login: string; links: string[]; limits: Record<string, Win> };

/** Раздел машины: порядок аккаунтов каждого слота и слоты сессий, ещё не открытых. */
type Machine = { slots: Record<string, string[]>; pending?: Record<string, string | null> };
/** Раздел сессии: слот и «ход оборван лимитом» (на каком аккаунте). */
type Mine = { slot: string | null; cut?: string };

/** Порог: 95 % за 5 ч, 98 % за неделю (и прочие окна). */
export const limitOf = (w: string) => (w === "five_hour" ? 0.95 : 0.98);
export const CONTINUE = "Продолжай";

const sec = () => Math.floor(Date.now() / 1000);
const hhmm = (t: number) => new Date(t * 1000).toTimeString().slice(0, 5);
const pct = (u: number) => `${Math.round(u * 100)} %`;
const winName = (w: string) => (w === "five_hour" ? "5 ч" : w === "seven_day" ? "нед." : w);

/** Окна аккаунта, которые сейчас у порога (сброс ещё не прошёл). */
function overWindows(a: Acc | undefined, now: number): Array<[string, Win]> {
  return Object.entries(a?.limits ?? {}).filter(([w, v]) => v.utilization >= limitOf(w) && !(v.resetsAt && v.resetsAt <= now));
}
export const over = (a: Acc | undefined, now: number) => overWindows(a, now).length > 0;
/** Когда аккаунт снова годится: самый поздний сброс его окон у порога. */
const usableAt = (a: Acc | undefined, now: number) => Math.max(0, ...overWindows(a, now).map(([, v]) => v.resetsAt || 0));

/** Окна моложе двух минут — свежие: то же, что спрашивает страница аккаунтов (max_age 120). */
const FRESH_S = 120;

export function make(): Module {
  let host: Host;
  /** папка слота — в папке данных Host */
  const slotDir = (slot: string) => join(host.dataDir, "slots", slot);
  /** копия записей accounts: fields roster читаются синхронно */
  let accs: Record<string, Acc> = {};
  /** подмены слота идут по одной */
  const chains = new Map<string, Promise<unknown>>();
  /** таймер ожидания сброса слота */
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const mstore = () => host.store<Machine>();
  const order = (): Record<string, string[]> => mstore().get()?.slots ?? {};
  const mine = (s: Session) => s.store<Mine>().get();
  const slotOf = (s: Session) => mine(s)?.slot ?? null;
  /** Кто сейчас в папке слота — по записям accounts. */
  const whoIn = (slot: string): string | null => {
    const d = resolve(slotDir(slot));
    return Object.entries(accs).find(([, a]) => (a.links ?? []).some((l) => resolve(l) === d))?.[0] ?? null;
  };
  const sessionsIn = (slot: string): Session[] =>
    host
      .sessions()
      .map((x) => host.session(x.callsign))
      .filter((s): s is Session => !!s && slotOf(s) === slot);

  /** Записи аккаунтов; only — окна этого аккаунта старше FRESH_S берутся у Claude (кандидат подмены). */
  async function refresh(only?: string): Promise<void> {
    const r = await host.request("machine.accounts", only ? { max_age: FRESH_S, only } : {});
    if (r.ok) accs = ((r.result as { accounts?: Record<string, Acc> })?.accounts ?? {}) as Record<string, Acc>;
    else host.log({ kind: "refuse", ev: "accounts", word: r.error, why: `machine.accounts: ${r.error}` });
  }

  /** Следующий по порядку слота: вошёл и ниже порога (может стоять и в другом слоте). */
  function candidate(slot: string, now: number): string | null {
    const cur = whoIn(slot);
    for (const name of order()[slot] ?? []) {
      if (name === cur) continue;
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
    if (!cur || !over(accs[cur], now) || candidate(slot, now)) return null;
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

  function lock<T>(slot: string, fn: () => Promise<T>): Promise<T> {
    const prev = chains.get(slot) ?? Promise.resolve();
    const p = prev.then(fn, fn);
    chains.set(slot, p.catch(() => undefined));
    return p;
  }

  /** Перевесить ссылку слота на аккаунт to через accounts. Ответ — прежний аккаунт или отказ словом. */
  async function place(slot: string, to: string, why: string, by?: string): Promise<{ ok: true; from: string | null } | { ok: false; error: string }> {
    const from = whoIn(slot);
    const r = await host.request("account.place", { dir: slotDir(slot), account: to });
    if (!r.ok) {
      host.log({ kind: "refuse", ev: "slot.swap", word: r.error, slot, why: `${slot}: accounts отказал в подмене ${from ?? "—"} → ${to}: ${r.error}` });
      return r;
    }
    await refresh();
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
    return lock(slot, async () => {
      if (whoIn(slot) !== expect) return;
      // расход аккаунта на других машинах видно только у Claude: окна кандидата — свежие; он уже у порога — следующий
      let next: string | null = null;
      for (let i = 0; i < (order()[slot]?.length ?? 0); i++) {
        const n = candidate(slot, sec());
        if (!n) break;
        await refresh(n);
        if (!over(accs[n], sec())) {
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
    return lock(slot, async () => {
      await refresh();
      const now = sec();
      const cur = whoIn(slot);
      let to: string | null = cur && !over(accs[cur], now) ? cur : null;
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
    // имени аккаунта в событии нет: сброс не тот, что у окна аккаунта в слоте, а тот, что у окна другого, —
    // это поздний ответ вызова, ушедшего до подмены
    const mineAt = accs[cur]?.limits?.[type]?.resetsAt;
    const late =
      resetsAt && mineAt !== resetsAt
        ? Object.entries(accs).find(([n, a]) => n !== cur && a.limits?.[type]?.resetsAt === resetsAt)?.[0]
        : undefined;
    const account = late ?? cur;
    const at = sec();
    const w = { utilization: u, resetsAt };
    accs[account] = { ...accs[account], limits: { ...accs[account]?.limits, [type]: { ...w, at, src: "event" } } };
    void host.request("account.usage", { account, src: "event", at, windows: { [type]: w } }).then((r) => {
      if (!r.ok) host.log({ kind: "refuse", ev: "account.usage", word: r.error, why: `${account}: ${r.error}` });
    });
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

  const requests: Module["requests"] = {
    async "machine.slots"() {
      await refresh();
      const slots: Record<string, unknown> = {};
      for (const [name, list] of Object.entries(order())) {
        slots[name] = { account: whoIn(name), order: list, wait: waitOf(name), sessions: sessionsIn(name).map((s) => s.info.callsign) };
      }
      return { slots };
    },

    async "slot.set"(f) {
      const slot = f.slot;
      if (typeof slot !== "string" || !/^[A-Za-z0-9_-]+$/.test(slot)) throw refuse("bad_frame", "имя слота — латиница, цифры, - и _");
      const list = Array.isArray(f.order) ? (f.order as unknown[]).map(String) : [];
      return lock(slot, async () => {
        await refresh();
        for (const n of list) if (!accs[n]) throw refuse("no_account", `${n}: такого аккаунта в accounts нет`);
        const known = order()[slot];
        if (!list.length) {
          if (!known) throw refuse("no_slot", `слота ${slot} нет`);
          if (sessionsIn(slot).length) throw refuse("has_sessions", `в слоте ${slot} есть сессии`);
          const cur = whoIn(slot);
          if (cur) {
            const r = await host.request("account.place", { dir: slotDir(slot), account: null });
            if (!r.ok) throw refuse(r.error, `${cur}: снять ссылку слота — ${r.error}`);
            await refresh();
          }
          mstore().update((m) => {
            const slots = { ...(m?.slots ?? {}) };
            delete slots[slot];
            return { ...m, slots };
          });
          host.log({ ev: "slot.set", slot, why: `слот ${slot} удалён` });
          return { account: null };
        }
        let cur = whoIn(slot);
        if (!cur) {
          // новый слот берёт первый вошедший аккаунт порядка (хоть и стоящий в другом слоте); такого нет — слота нет:
          // сессии в слоте без входа шли бы «Not logged in» (живой прогон 31 окт.)
          const first = list.find((n) => accs[n]?.login === "ok");
          if (!first) throw refuse("no_reserve", `${slot}: в порядке нет вошедшего аккаунта`);
          mstore().update((m) => ({ ...m, slots: { ...(m?.slots ?? {}), [slot]: list } }));
          const r = await place(slot, first, "новый слот");
          if (!r.ok) {
            mstore().update((m) => {
              const slots = { ...(m?.slots ?? {}) };
              delete slots[slot];
              return { ...m, slots };
            });
            throw refuse(r.error, `${slot}: ${first} не встал в слот — ${r.error}`);
          }
          cur = first;
        } else mstore().update((m) => ({ ...m, slots: { ...(m?.slots ?? {}), [slot]: list } }));
        host.log({ ev: "slot.set", slot, order: list });
        arm(slot);
        return { account: cur };
      });
    },

    async "slot.swap"(f, ctx) {
      const slot = String(f.slot ?? "");
      if (!order()[slot]) throw refuse("no_slot", `слота ${slot} нет`);
      return lock(slot, async () => {
        await refresh();
        let to = typeof f.account === "string" ? f.account : null;
        if (to && !accs[to]) throw refuse("no_account", `${to}: такого аккаунта в accounts нет`);
        to ??= candidate(slot, sec());
        if (!to) throw refuse("no_reserve", `${slot}: в запасе нет вошедшего аккаунта ниже порога`);
        const r = await place(slot, to, "вручную", ctx.from);
        if (!r.ok) throw refuse(r.error, `${slot}: ${r.error}`);
        arm(slot);
        resume(slot);
        return { from: r.from, to };
      });
    },

    "session.slot"(f, ctx) {
      const callsign = String(f.callsign ?? "");
      const slot = f.slot === null || f.slot === undefined ? null : String(f.slot);
      if (slot !== null && !order()[slot]) throw refuse("no_slot", `слота ${slot} нет`);
      const s = ctx.host.session(callsign);
      if (!s) {
        // сессия ещё не открыта: слот — до старта, в query() он уйдёт из session()
        mstore().update((m) => ({ slots: {}, ...m, pending: { ...(m?.pending ?? {}), [callsign]: slot } }));
        return { restart: false };
      }
      return { restart: setSlot(s, slot) };
    },
  };

  return {
    requests,
    fields: {
      slot: (s) => {
        const slot = slotOf(s);
        return slot ? { name: slot, wait: waitOf(slot) } : undefined;
      },
      account: (s) => {
        const slot = slotOf(s);
        return slot ? whoIn(slot) : undefined;
      },
    },
    session(s) {
      const pend = mstore().get()?.pending;
      if (pend && s.info.callsign in pend) {
        s.store<Mine>().set({ slot: pend[s.info.callsign] });
        mstore().update((m) => {
          const pending = { ...(m?.pending ?? {}) };
          delete pending[s.info.callsign];
          return { slots: {}, ...m, pending };
        });
      }
      const slot = slotOf(s);
      if (!slot) return undefined;
      // папку не создаём: на её месте — ссылка accounts; слота без аккаунта не бывает (slot.set)
      return { env: { CLAUDE_SECURESTORAGE_CONFIG_DIR: slotDir(slot) } };
    },
    on: {
      event: onEvent,
      state(s: Session, st: SessionState) {
        // ход оборван, а подмена уже прошла раньше result: «Продолжай» на свободной сессии
        const slot = slotOf(s);
        if (slot && st === "idle" && mine(s)?.cut !== undefined && !timers.has(slot) && whoIn(slot) !== mine(s)?.cut) void lock(slot, async () => resume(slot));
      },
    },
    async start(h) {
      host = h;
      await refresh();
      for (const slot of Object.keys(order())) arm(slot);
    },
    stop() {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    },
  };
}
