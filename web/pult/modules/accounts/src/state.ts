// Ответы машин и идущие входы. Экран открыт — спросить машины; сменился аккаунт сессии — перечитать её машину со свежими окнами.
// Код входа уходит только машине и здесь не остаётся.
import type { App, Roster } from "@switchboard/web-core";
import { accountChanged, type AccountsAnswer, createStore, linkText, machineAnswers, machinesWith, okOf, type Result, useModule } from "@switchboard/web-ui";
import { machineOf } from "@switchboard/protocol";

export type LoginCard = { machine: string; account: string; url?: string; sending?: boolean; failed?: string; word?: string; done?: string };

const WORDS: Record<string, string> = {
  no_reserve: "В запасе нет вошедшего ниже порога — слот прежний",
  has_sessions: "В слоте есть сессии — сначала переведите их",
  no_account: "Такого аккаунта нет на машине",
  no_slot: "Такого слота нет",
  not_logged_in: "У аккаунта нет входа",
  refresh_locked: "Claude сейчас обновляет вход этого аккаунта — повторите через минуту",
  slot_dir_busy: "На месте слота на машине папка с файлами — разберите её",
  account_dir_busy: "Папка аккаунта занята — повторите через минуту",
  bad_code: "Код не принят — вход закрыт",
  not_started: "Вход прервался: Host перезапускался",
};

/** Отказ машины строкой: что случилось и её причина. */
export const refusal = (r: { error: string; why?: string }, machine?: string) => `${WORDS[r.error] ?? linkText(r.error, machine)}${r.why ? ` — ${r.why}` : ""}`;

export type AccountsState = ReturnType<typeof createAccountsState>;
export const useAccounts = (): AccountsState => useModule<AccountsState>();

export function createAccountsState(app: App) {
  const ask = (maxAge: number) => (machine: string) => app.read<AccountsAnswer>("machine.accounts", { machine, max_age: maxAge });
  const answers = machineAnswers<AccountsAnswer>(app, ask(120), () => machinesWith(app, "machine.accounts"));
  const logins = createStore<Record<string, LoginCard>>({}, () => app.changed());
  /** аккаунт сессии в прошлом roster */
  const known: Record<string, string> = {};
  const edit = (key: string, patch: Partial<LoginCard>) => logins.set((all) => void (all[key] = { ...all[key], ...patch }));

  async function beginLogin(machine: string, account: string): Promise<void> {
    const key = `${machine}:${account}`;
    logins.set((all) => void (all[key] = { machine, account }));
    const r = await app.request<{ url: string }>("machine.login", { machine, account });
    if (!r.ok) return edit(key, { failed: refusal(r, machine), word: r.error });
    edit(key, { url: r.result.url });
    void answers.reload(machine);
  }

  return {
    answers,
    logins: () => logins.get(),
    beginLogin,
    hideLogin: (key: string) => logins.set((all) => void delete all[key]),
    async sendCode(key: string, code: string): Promise<void> {
      const card = logins.get()[key];
      if (!code.trim() || !card) return;
      edit(key, { sending: true });
      const r: Result<{ email?: string; plan?: string }> = await app.request("machine.login_code", { machine: card.machine, account: card.account, code });
      if (!r.ok) return edit(key, { sending: false, url: undefined, failed: refusal(r, card.machine), word: r.error });
      edit(key, { sending: false, url: undefined, done: `Вошёл: ${[r.result.email, r.result.plan].filter(Boolean).join(" · ")}` });
      void answers.reload(card.machine);
    },
    /** Входы, которые идут сейчас: по последним ответам. */
    pending: () =>
      Object.values(answers.get())
        .flatMap((a) => Object.values(okOf(a)?.accounts ?? {}))
        .filter((a) => a.login === "pending").length,
    onRoster(r: Roster) {
      const changed = accountChanged(known, r.sessions);
      if (!answers.isOpen()) return;
      for (const machine of new Set(changed.map((c) => machineOf(c)!))) void answers.reload(machine, ask(0));
    },
  };
}
