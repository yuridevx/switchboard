// Состояние аккаунтов и слотов всего времени жизни модуля и действия с запросами. Ничего не считает за владельцев:
// окна — как прислал accounts машины, кто в слоте — как прислал slots. Расход почты на других машинах Host читает у Claude сам,
// перед подменой; пульт его не пересылает.
import type { App, Roster } from "@switchboard/web-core";
import { machineOf } from "@switchboard/protocol";
import { type AccountInfo, type AccountsAnswer, accountChanged, type ConnState, createStore, machineAnswers, machinesWith, type MachineAnswer, type MachineAnswers, linkText, okOf, type Result, type SlotInfo, type SlotsAnswer, useModule } from "@switchboard/web-ui";

export type Account = AccountInfo;
export type Slot = SlotInfo;
export type Login = { machine: string; account: string; phase: "wait" | "url" | "code" | "ok" | "bad" | "err"; url?: string; email?: string; plan?: string; err?: string };

type State = {
  logins: Record<string, Login>;
  /** прошлый account сессии: сменился — Host сделал подмену */
  prevAccount: Record<string, string>;
};

/** Ответ без отказа, иначе undefined. */

/** Слова отказа slots и accounts → строка на экране. */
const WORDS: Record<string, string> = {
  no_reserve: "В запасе нет вошедшего ниже порога — слот прежний",
  has_sessions: "В слоте есть сессии — сначала переведите их",
  no_account: "Такого аккаунта нет на машине",
  no_slot: "Такого слота нет",
  in_slot: "Аккаунт в слоте — сначала смените его в слоте",
  bad_code: "Код не принят — вход закрыт",
  not_started: "Вход прервался: Host перезапускался",
  not_logged_in: "У аккаунта нет входа",
  refresh_locked: "Claude сейчас обновляет вход этого аккаунта — повторите через минуту",
  slot_dir_busy: "На месте слота на машине папка с файлами — разберите её",
};
export const say = (w: string) => WORDS[w] ?? linkText(w);

/** Слоты машины, где аккаунт стоит сейчас: один аккаунт может стоять в нескольких. */
export function slotsWith(list: Record<string, Slot>, account: string): string[] {
  return Object.entries(list)
    .filter(([, s]) => s.account === account)
    .map(([n]) => n);
}

export type AccountsStore = ReturnType<typeof createAccountsStore>;
/** Стор модуля в экранах. */
export const useAccounts = (): AccountsStore => useModule<AccountsStore>();

export function createAccountsStore(app: App) {
  const store = createStore<State>({ logins: {}, prevAccount: {} }, () => app.changed());
  const machines = (n: string) => machinesWith(app, n);

  async function askAccounts(m: string, body: Record<string, unknown>) {
    const r = await app.request<Partial<AccountsAnswer>>("machine.accounts", { machine: m, ...body });
    return r.ok ? { ok: true as const, result: { accounts: r.result.accounts ?? {} } } : r;
  }
  async function askSlots(m: string) {
    const r = await app.request<Partial<SlotsAnswer>>("machine.slots", { machine: m });
    return r.ok ? { ok: true as const, result: { slots: r.result.slots ?? {} } } : r;
  }
  /** Ответы машин: цикл «экран открыт — спросить, машина пришла — доспросить» у обоих один; открыли экран — machine.accounts { max_age: 120 } и machine.slots. */
  const accs: MachineAnswers<AccountsAnswer> = machineAnswers<AccountsAnswer>(app, (m) => askAccounts(m, { max_age: 120 }), () => machines("machine.accounts"));
  const slots: MachineAnswers<SlotsAnswer> = machineAnswers<SlotsAnswer>(app, askSlots, () => machines("machine.slots"));
  /** Свежие окна: после своего действия и подмены кэш Host не годится. */
  const loadAccounts = (m: string) => accs.reload(m, (x) => askAccounts(x, { max_age: 0 }));
  const loadSlots = (m: string) => slots.reload(m);

  const accsOf = (m: string) => okOf(accs.get()[m])?.accounts;
  const slotsOf = (m: string) => okOf(slots.get()[m])?.slots;
  /** Ответы всех машин без отказов. */
  const okAnswers = <T extends object, R>(all: Readonly<Record<string, MachineAnswer<T>>>, pick: (a: T) => R) => {
    const out: Record<string, R> = {};
    for (const [m, a] of Object.entries(all)) {
      const ok = okOf(a);
      if (ok) out[m] = pick(ok);
    }
    return out;
  };
  const allAccs = () => okAnswers(accs.get(), (a) => a.accounts);

  async function login(m: string, account: string) {
    const key = `${m}:${account}`;
    store.set((s) => void (s.logins[key] = { machine: m, account, phase: "wait" }));
    const r = await app.request<{ url: string }>("machine.login", { machine: m, account });
    store.set((s) => void (s.logins[key] = r.ok ? { machine: m, account, phase: "url", url: r.result.url } : { machine: m, account, phase: "err", err: r.error }));
  }

  const editLogin = (key: string, patch: Partial<Login>) =>
    store.set((s) => {
      if (s.logins[key]) Object.assign(s.logins[key], patch);
    });

  return {
    state: store.get,
    machines,
    accsOf,
    slotsOf,
    allAccs,
    allSlots: () => okAnswers(slots.get(), (a) => a.slots),
    /** Отказы владельцев: «машина · запрос» → слово; ответ снимает его. Экран пишет слово, а не «аккаунтов нет». */
    refused() {
      const out: Record<string, string> = {};
      for (const [m, a] of Object.entries(accs.get())) if ("error" in a) out[`${m} · machine.accounts`] = a.error;
      for (const [m, a] of Object.entries(slots.get())) if ("error" in a) out[`${m} · machine.slots`] = a.error;
      return out;
    },
    /** Первые ответы machine.accounts пришли: опрос лимитов занимает секунды — экран пишет «загружаю», а не «нет». */
    loaded: () => machines("machine.accounts").every((m) => accs.get()[m] !== undefined),

    /** Экран открыт: читает всё заново; возврат — экран закрыт. */
    mount(): () => void {
      const a = accs.mount();
      const b = slots.mount();
      return () => {
        a();
        b();
      };
    },

    /** Машина вернулась, пришла или перезапустилась — её аккаунты и слоты. */
    onLink(state: ConnState, machine?: string) {
      accs.onLink(state, machine);
      slots.onLink(state, machine);
    },

    /** Подмену делает Host: у сессий машины сменился account — перечитать её слоты и окна. */
    onRoster(r: Roster) {
      let changed = new Set<string>();
      store.set((s) => void (changed = new Set(accountChanged(s.prevAccount, r.sessions).map((c) => machineOf(c) ?? ""))));
      if (!accs.isOpen()) return;
      for (const m of changed) {
        if (!m) continue;
        if (app.can(m, "machine.slots")) void loadSlots(m);
        if (app.can(m, "machine.accounts")) void loadAccounts(m);
      }
    },

    /** Число идущих входов. */
    pending: () => Object.values(allAccs()).reduce((n, list) => n + Object.values(list).filter((a) => a.login === "pending").length, 0),

    // ───── вход ─────
    login,
    hideLogin: (key: string) => store.set((s) => void delete s.logins[key]),
    async code(key: string, value: string) {
      const l = store.get().logins[key];
      const c = value.trim();
      if (!l || !c) return;
      editLogin(key, { phase: "code" });
      // код — как есть, по TLS через relay только этой машине; в хранилище страницы его нет
      const r = await app.request<{ email: string; plan: string }>("machine.login_code", { machine: l.machine, account: l.account, code: c });
      if (r.ok) {
        editLogin(key, { phase: "ok", email: r.result.email, plan: r.result.plan });
        await loadAccounts(l.machine);
      } else editLogin(key, { phase: r.error === "bad_code" ? "bad" : "err", err: r.error });
    },

    // ───── действия слотов ─────
    async swap(m: string, slot: string, account: string): Promise<Result<string>> {
      const r = await app.request<{ from: string | null; to: string }>("slot.swap", { machine: m, slot, ...(account ? { account } : {}) });
      if (!r.ok) return { ok: false, error: say(r.error) };
      const list = slotsOf(m);
      if (list?.[slot]) slots.put(m, { slots: { ...list, [slot]: { ...list[slot], account: r.result.to } } });
      return { ok: true, result: `${r.result.from ?? "—"} → ${r.result.to}` };
    },
    async setOrder(m: string, slot: string, order: string[]): Promise<Result<string>> {
      const r = await app.request<{ account: string | null }>("slot.set", { machine: m, slot, order });
      if (!r.ok) return { ok: false, error: say(r.error) };
      await loadSlots(m);
      return { ok: true, result: order.length ? "порядок сохранён" : `слот ${slot} удалён` };
    },
    async moveSessions(m: string, list: string[], target: string): Promise<Result<string>> {
      const out: string[] = [];
      for (const callsign of list) {
        const r = await app.request<{ restart: boolean }>("session.slot", { callsign, slot: target || null });
        out.push(`${callsign}: ${r.ok ? (r.result.restart ? "перейдёт между ходами" : "перешла") : say(r.error)}`);
      }
      await loadSlots(m);
      return { ok: true, result: out.join(" · ") };
    },
    /** Удалить аккаунт: сменить его в слотах, убрать из порядка, стереть. Пульт складывает шаги сам — каждый после ответа предыдущего. */
    async remove(m: string, account: string, pickNext: string, step: (text: string) => void): Promise<Result<string>> {
      const list = slotsOf(m) ?? {};
      for (const inSlot of slotsWith(list, account)) {
        step(`слот ${inSlot}: смена аккаунта…`);
        const next = pickNext && list[inSlot].order.includes(pickNext) ? pickNext : "";
        const r = await app.request<{ from: string; to: string }>("slot.swap", { machine: m, slot: inSlot, ...(next ? { account: next } : {}) });
        if (!r.ok) return { ok: false, error: `слот ${inSlot}: ${say(r.error)}` };
      }
      for (const [name, s] of Object.entries(list)) {
        if (!s.order.includes(account)) continue;
        const r = await app.request("slot.set", { machine: m, slot: name, order: s.order.filter((x) => x !== account) });
        if (!r.ok) return { ok: false, error: `slot.set ${name}: ${say(r.error)}` };
      }
      const r = await app.request<{ wiped: boolean }>("machine.account_remove", { machine: m, account });
      if (!r.ok) return { ok: false, error: say(r.error) };
      await Promise.all([loadAccounts(m), loadSlots(m)]);
      return { ok: true, result: `${account} удалён с ${m}` };
    },
  };
}
