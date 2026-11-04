// Память экрана аккаунтов на время жизни страницы: ответы машин одним запросом machine.accounts и идущие входы.
// Окна и кто в слоте — как прислала машина; расход почты на других машинах Host читает у Claude сам, перед подменой.
import { machineOf } from "@switchboard/protocol";
import type { App, Roster } from "@switchboard/web-core";
import { type AccountInfo, type AccountsAnswer, accountChanged, type ConnState, createStore, linkText, machineAnswers, machinesWith, okOf, type Result, type SlotInfo, useModule } from "@switchboard/web-ui";

export type Account = AccountInfo;
export type Slot = SlotInfo;
export type Login = { machine: string; account: string; phase: "wait" | "url" | "code" | "ok" | "bad" | "err"; url?: string; email?: string; plan?: string; err?: string };

/** Слова отказа модуля аккаунтов → строка на экране. */
const WORDS: Record<string, string> = {
  no_reserve: "В запасе нет вошедшего ниже порога — слот прежний",
  has_sessions: "В слоте есть сессии — сначала переведите их",
  no_account: "Такого аккаунта нет на машине",
  no_slot: "Такого слота нет",
  bad_code: "Код не принят — вход закрыт",
  not_started: "Вход прервался: Host перезапускался",
  not_logged_in: "У аккаунта нет входа",
  refresh_locked: "Claude сейчас обновляет вход этого аккаунта — повторите через минуту",
  slot_dir_busy: "На месте слота на машине папка с файлами — разберите её",
  account_dir_busy: "Папка аккаунта занята — повторите через минуту",
};
export const say = (word: string) => WORDS[word] ?? linkText(word);
/** Отказ со своей причиной: в какой слот он упёрся, знает машина. */
const sayWhy = (r: { error: string; why?: string }) => (r.why ? `${say(r.error)} — ${r.why}` : say(r.error));

/** Слоты машины, где аккаунт стоит сейчас: один аккаунт может стоять в нескольких. */
export const slotsWith = (slots: Record<string, Slot>, account: string) => Object.keys(slots).filter((name) => slots[name].account === account);

export type AccountsStore = ReturnType<typeof createAccountsStore>;
export const useAccounts = (): AccountsStore => useModule<AccountsStore>();

export function createAccountsStore(app: App) {
  /** logins — идущие входы; lastAccount — прошлый account сессии: сменился — Host сделал подмену. */
  const local = createStore<{ logins: Record<string, Login>; lastAccount: Record<string, string> }>({ logins: {}, lastAccount: {} }, () => app.changed());
  const machines = (request: string) => machinesWith(app, request);
  const ask = (m: string, body: Record<string, unknown>) => app.read<AccountsAnswer>("machine.accounts", { machine: m, ...body });

  /** Открыли экран — окна не старше двух минут; в ответе и слоты. */
  const answers = machineAnswers<AccountsAnswer>(app, (m) => ask(m, { max_age: 120 }), () => machines("machine.accounts"));
  /** После своего действия и подмены кэш Host не годится. */
  const reloadFresh = (m: string) => answers.reload(m, (x) => ask(x, { max_age: 0 }));
  /** После правки слотов окна не нужны. */
  const reloadRecords = (m: string) => answers.reload(m, (x) => ask(x, {}));

  const answerOf = (m: string) => okOf(answers.get()[m]);
  function fromAll<R>(pick: (a: AccountsAnswer) => R): Record<string, R> {
    const out: Record<string, R> = {};
    for (const m of Object.keys(answers.get())) {
      const a = answerOf(m);
      if (a) out[m] = pick(a);
    }
    return out;
  }
  const allAccounts = () => fromAll((a) => a.accounts);

  const editLogin = (key: string, patch: Partial<Login>) =>
    local.set((s) => {
      if (s.logins[key]) Object.assign(s.logins[key], patch);
    });

  async function login(m: string, account: string) {
    const key = `${m}:${account}`;
    local.set((s) => void (s.logins[key] = { machine: m, account, phase: "wait" }));
    const r = await app.request<{ url: string }>("machine.login", { machine: m, account });
    local.set((s) => void (s.logins[key] = r.ok ? { machine: m, account, phase: "url", url: r.result.url } : { machine: m, account, phase: "err", err: r.error }));
  }

  return {
    logins: () => local.get().logins,
    machines,
    accountsOf: (m: string) => answerOf(m)?.accounts,
    slotsOf: (m: string) => answerOf(m)?.slots,
    allAccounts,
    allSlots: () => fromAll((a) => a.slots),
    /** Отказы владельцев: «машина · запрос» → слово; ответ снимает его. Экран пишет слово, а не «аккаунтов нет». */
    refused() {
      const out: Record<string, string> = {};
      for (const [m, a] of Object.entries(answers.get())) if ("error" in a) out[`${m} · machine.accounts`] = a.error;
      return out;
    },
    /** Первые ответы пришли: опрос лимитов занимает секунды — экран пишет «загружаю», а не «нет». */
    loaded: () => machines("machine.accounts").every((m) => answers.get()[m] !== undefined),
    waiting: (m: string) => answers.get()[m] === undefined,
    /** Экран открыт: читает всё заново; возврат — экран закрыт. */
    mount: () => answers.mount(),
    /** Машина вернулась, пришла или перезапустилась — её аккаунты и слоты. */
    onLink: (state: ConnState, machine?: string) => answers.onLink(state, machine),
    /** Подмену делает Host: у сессий машины сменился account — перечитать её слоты и окна. */
    onRoster(r: Roster) {
      let changed: string[] = [];
      local.set((s) => void (changed = accountChanged(s.lastAccount, r.sessions)));
      if (!answers.isOpen()) return;
      for (const m of new Set(changed.map((c) => machineOf(c) ?? ""))) if (m && app.can(m, "machine.accounts")) void reloadFresh(m);
    },
    /** Число идущих входов. */
    pending: () => Object.values(allAccounts()).reduce((n, list) => n + Object.values(list).filter((a) => a.login === "pending").length, 0),

    login,
    hideLogin: (key: string) => local.set((s) => void delete s.logins[key]),
    async sendCode(key: string, value: string) {
      const l = local.get().logins[key];
      const code = value.trim();
      if (!l || !code) return;
      editLogin(key, { phase: "code" });
      // код — как есть, по TLS через relay только этой машине; в хранилище страницы его нет
      const r = await app.request<{ email: string; plan: string }>("machine.login_code", { machine: l.machine, account: l.account, code });
      if (!r.ok) return editLogin(key, { phase: r.error === "bad_code" ? "bad" : "err", err: r.error });
      editLogin(key, { phase: "ok", email: r.result.email, plan: r.result.plan });
      await reloadFresh(l.machine);
    },

    async swap(m: string, slot: string, account: string): Promise<Result<string>> {
      const r = await app.request<{ from: string | null; to: string }>("slot.swap", { machine: m, slot, ...(account ? { account } : {}) });
      if (!r.ok) return { ok: false, error: sayWhy(r) };
      const known = answerOf(m);
      if (known?.slots?.[slot]) answers.put(m, { ...known, slots: { ...known.slots, [slot]: { ...known.slots[slot], account: r.result.to } } });
      return { ok: true, result: `${r.result.from ?? "—"} → ${r.result.to}` };
    },
    async setOrder(m: string, slot: string, order: string[]): Promise<Result<string>> {
      const r = await app.request<{ account: string | null }>("slot.set", { machine: m, slot, order });
      if (!r.ok) return { ok: false, error: sayWhy(r) };
      await reloadRecords(m);
      return { ok: true, result: order.length ? "порядок сохранён" : `слот ${slot} удалён` };
    },
    async moveSessions(m: string, callsigns: string[], target: string): Promise<Result<string>> {
      const lines: string[] = [];
      for (const callsign of callsigns) {
        const r = await app.request<{ restart: boolean }>("session.slot", { callsign, slot: target || null });
        lines.push(`${callsign}: ${r.ok ? (r.result.restart ? "перейдёт между ходами" : "перешла") : say(r.error)}`);
      }
      await reloadRecords(m);
      return { ok: true, result: lines.join(" · ") };
    },
    /** Удалить аккаунт: сменить его в слотах, убрать из порядка и стереть — один запрос, шаги выполняет машина. */
    async remove(m: string, account: string, next: string): Promise<Result<string>> {
      const r = await app.request<{ wiped: boolean }>("machine.account_remove", { machine: m, account, ...(next ? { next } : {}) });
      if (!r.ok) return { ok: false, error: sayWhy(r) };
      await reloadFresh(m);
      return { ok: true, result: `${account} удалён с ${m}` };
    },
  };
}
