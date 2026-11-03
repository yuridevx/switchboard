// Состояние аккаунтов и слотов всего времени жизни модуля и действия с запросами. Ничего не считает за владельцев:
// окна — как прислал accounts машины, кто в слоте — как прислал slots. Расход почты на других машинах Host читает у Claude сам,
// перед подменой; пульт его не пересылает.
import type { App, Roster } from "@switchboard/web-core";
import { machineOf } from "@switchboard/protocol";
import { createStore } from "@switchboard/web-ui";

export type Window = { utilization: number; resetsAt?: number; at?: number; src?: string };
export type Account = { login: "ok" | "none" | "pending"; links?: string[]; email?: string; plan?: string; checked?: number; limits?: Record<string, Window>; err?: string };
export type Slot = { account: string | null; order: string[]; wait: number | null; sessions: string[] };
export type Login = { machine: string; account: string; phase: "wait" | "url" | "code" | "ok" | "bad" | "err"; url?: string; email?: string; plan?: string; err?: string };
export type Tone = "ok" | "bad" | "wait" | undefined;
/** Строка итога действия: её держит открытый экран. */
export type Say = (text: string, tone?: Tone) => void;

type State = {
  accs: Record<string, Record<string, Account>>;
  slots: Record<string, Record<string, Slot>>;
  logins: Record<string, Login>;
  /** прошлый account сессии: сменился — Host сделал подмену */
  prevAccount: Record<string, string>;
  /** «машина · запрос» → слово отказа владельца при загрузке */
  refused: Record<string, string>;
  /** сколько экранов открыто: подмену и новую машину перечитываем только при открытом экране */
  opened: number;
  /** первый ответ machine.accounts ещё не пришёл: опрос лимитов занимает секунды — экран пишет «загружаю», а не «нет» */
  loaded: boolean;
  /** машины, чьи аккаунты и слоты уже взяты: новая в roster — догрузить */
  known: Record<string, true>;
};

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
export const say = (w: string) => WORDS[w] ?? w;

/** Слоты машины, где аккаунт стоит сейчас: один аккаунт может стоять в нескольких. */
export function slotsWith(list: Record<string, Slot>, account: string): string[] {
  return Object.entries(list)
    .filter(([, s]) => s.account === account)
    .map(([n]) => n);
}

export type AccountsStore = ReturnType<typeof createAccountsStore>;

export function createAccountsStore() {
  let app: App;
  const store = createStore<State>({ accs: {}, slots: {}, logins: {}, prevAccount: {}, refused: {}, opened: 0, loaded: false, known: {} }, () => app.changed());

  const machines = (n: string) => (app.roster()?.machines ?? []).filter((m) => m.contract?.[n] !== undefined).map((m) => m.machine);

  /** Отказ владельца — словом на экране, а не «аккаунтов нет»; ответ снимает его. */
  function refusal(s: State, m: string, n: string, r: { ok: boolean; error?: string }) {
    if (r.ok) delete s.refused[`${m} · ${n}`];
    else s.refused[`${m} · ${n}`] = String(r.error);
  }

  async function loadAccounts(m: string, maxAge?: number) {
    const r = await app.request<{ accounts: Record<string, Account> }>("machine.accounts", { machine: m, ...(maxAge ? { max_age: maxAge } : {}) });
    store.set((s) => {
      if (r.ok) s.accs[m] = r.result.accounts ?? {};
      refusal(s as State, m, "machine.accounts", r);
    });
  }

  async function loadSlots(m: string) {
    const r = await app.request<{ slots: Record<string, Slot> }>("machine.slots", { machine: m });
    store.set((s) => {
      if (r.ok) s.slots[m] = r.result.slots ?? {};
      refusal(s as State, m, "machine.slots", r);
    });
  }

  /** Открыли экран: каждой машине — machine.accounts { max_age: 120 } и machine.slots. */
  async function loadAll() {
    store.set((s) => {
      for (const m of [...machines("machine.accounts"), ...machines("machine.slots")]) s.known[m] = true;
    });
    await Promise.all([...machines("machine.accounts").map((m) => loadAccounts(m, 120)), ...machines("machine.slots").map((m) => loadSlots(m))]);
    store.set((s) => void (s.loaded = true));
  }

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
    start(a: App) {
      app = a;
    },
    state: store.get,
    machines,

    /** Экран открыт: читает всё заново; возврат — экран закрыт. */
    mount(): () => void {
      store.set((s) => void s.opened++);
      void loadAll();
      return () => store.set((s) => void s.opened--);
    },

    /** Подмену делает Host: у сессий машины сменился account — перечитать её слоты и окна. */
    onRoster(r: Roster) {
      const changed = new Set<string>();
      store.set((s) => {
        for (const x of r.sessions) {
          if (typeof x.account !== "string") continue;
          const was = s.prevAccount[x.callsign];
          if (was !== undefined && was !== x.account) changed.add(machineOf(x.callsign) ?? "");
          s.prevAccount[x.callsign] = x.account;
        }
        if (!s.opened) return;
        // машина пришла своим соединением позже — взять её аккаунты и слоты
        for (const m of new Set([...machines("machine.accounts"), ...machines("machine.slots")])) {
          if (s.known[m]) continue;
          s.known[m] = true;
          changed.add(m);
        }
      });
      if (!store.get().opened) return;
      for (const m of changed) {
        if (!m) continue;
        if (app.can(m, "machine.slots")) void loadSlots(m);
        if (app.can(m, "machine.accounts")) void loadAccounts(m);
      }
    },

    /** Число идущих входов. */
    pending: () => Object.values(store.get().accs).reduce((n, list) => n + Object.values(list).filter((a) => a.login === "pending").length, 0),

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
    /** Ссылка входа — в буфер; браузер отказал — ссылка остаётся на кнопке. */
    async copy(url: string) {
      try {
        await navigator.clipboard.writeText(url);
        app.toast("Ссылка скопирована", "ok");
      } catch {
        app.toast("Буфер недоступен — откройте ссылку кнопкой");
      }
    },

    // ───── действия слотов ─────
    async swap(m: string, slot: string, account: string, note: Say) {
      note("Меняю…");
      const r = await app.request<{ from: string | null; to: string }>("slot.swap", { machine: m, slot, ...(account ? { account } : {}) });
      if (!r.ok) return note(say(r.error), "bad");
      store.set((s) => {
        const sl = s.slots[m]?.[slot];
        if (sl) sl.account = r.result.to;
      });
      note(`${r.result.from ?? "—"} → ${r.result.to}`, "ok");
    },
    async setOrder(m: string, slot: string, order: string[], note: Say) {
      note("Сохраняю…");
      const r = await app.request<{ account: string | null }>("slot.set", { machine: m, slot, order });
      if (!r.ok) return note(say(r.error), "bad");
      await loadSlots(m);
      note(order.length ? "порядок сохранён" : `слот ${slot} удалён`, "ok");
    },
    async moveSessions(m: string, list: string[], target: string, note: Say) {
      const out: string[] = [];
      for (const callsign of list) {
        const r = await app.request<{ restart: boolean }>("session.slot", { callsign, slot: target || null });
        out.push(`${callsign}: ${r.ok ? (r.result.restart ? "перейдёт между ходами" : "перешла") : say(r.error)}`);
      }
      await loadSlots(m);
      note(out.join(" · "), "ok");
    },
    /** Удалить аккаунт: сменить его в слотах, убрать из порядка, стереть. Пульт складывает шаги сам — каждый после ответа предыдущего. */
    async remove(m: string, account: string, pickNext: string, note: Say, removed: () => void) {
      const list = store.get().slots[m] ?? {};
      for (const inSlot of slotsWith(list, account)) {
        note(`слот ${inSlot}: смена аккаунта…`);
        const next = pickNext && list[inSlot].order.includes(pickNext) ? pickNext : "";
        const r = await app.request<{ from: string; to: string }>("slot.swap", { machine: m, slot: inSlot, ...(next ? { account: next } : {}) });
        if (!r.ok) return note(`слот ${inSlot}: ${say(r.error)}`, "bad");
      }
      for (const [name, s] of Object.entries(list)) {
        if (!s.order.includes(account)) continue;
        const r = await app.request("slot.set", { machine: m, slot: name, order: s.order.filter((x) => x !== account) });
        if (!r.ok) return note(`slot.set ${name}: ${say(r.error)}`, "bad");
      }
      const r = await app.request<{ wiped: boolean }>("machine.account_remove", { machine: m, account });
      if (!r.ok) return note(say(r.error), "bad");
      removed();
      await Promise.all([loadAccounts(m), loadSlots(m)]);
      note(`${account} удалён с ${m}`, "ok");
    },
  };
}
