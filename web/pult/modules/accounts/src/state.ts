// Ответы машин и идущие входы. Экран открыт — записи всех машин, затем один опрос на почту; сменился аккаунт сессии — опрос нового.
// Код входа уходит только машине и здесь не остаётся.
import { machineOf } from "@switchboard/protocol";
import type { App, Roster } from "@switchboard/web-core";
import { accountChanged, type AccountsAnswer, createStore, linkText, machineAnswers, machinesWith, useModule } from "@switchboard/web-ui";
import { pollPlan, shortName } from "./merge.ts";

/** Вход на машине: один за раз. expected — аккаунт, с которого начали: если вошли другой почтой, он не изменился. */
export type Login = { expected?: string; url?: string; sending?: boolean };

const WORDS: Record<string, string> = {
  no_reserve: "В запасе нет вошедшего ниже порога",
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

const nowS = () => Math.floor(Date.now() / 1000);

export function createAccountsState(app: App) {
  const read = (machine: string, poll?: string[]) => app.read<AccountsAnswer>("machine.accounts", { machine, ...(poll?.length ? { poll } : {}) });
  const machines = () => machinesWith(app, "machine.accounts");
  /** Почты, о которых Claude уже спрашивали при этом открытии: отказ опроса не должен повторяться по кругу. */
  const asked = new Set<string>();

  function pollStale() {
    if (!answers.isOpen() || !machines().every((m) => answers.get()[m] !== undefined)) return;
    for (const [machine, emails] of pollPlan(answers.get(), nowS(), asked)) {
      emails.forEach((e) => asked.add(e));
      void answers.reload(machine, (m) => read(m, emails));
    }
  }

  const answers = machineAnswers<AccountsAnswer>(app, (machine) => read(machine), machines, pollStale);
  const logins = createStore<Record<string, Login>>({}, () => app.changed());
  /** аккаунт сессии в прошлом roster */
  const known: Record<string, string> = {};

  return {
    /** вкладка, которую открыли последней: заход без адреса вкладки возвращает на неё */
    seen: { tab: "logins" },
    answers,
    logins: () => logins.get(),
    mount() {
      asked.clear();
      return answers.mount();
    },
    /** Ответ — отказ строкой, если вход не начался. */
    async beginLogin(machine: string, expected?: string): Promise<string | null> {
      logins.set((all) => void (all[machine] = { expected }));
      const r = await app.request<{ url: string }>("machine.login", { machine });
      if (!r.ok) {
        logins.set((all) => void delete all[machine]);
        return refusal(r, machine);
      }
      logins.set((all) => void (all[machine] = { expected, url: r.result.url }));
      return null;
    },
    hideLogin: (machine: string) => logins.set((all) => void delete all[machine]),
    /** Итог для строки машины; код не остаётся нигде, кроме поля ввода. */
    async sendCode(machine: string, code: string): Promise<{ text: string; tone: "ok" | "bad" | "wait" } | null> {
      const card = logins.get()[machine];
      if (!card || !code.trim()) return null;
      logins.set((all) => void (all[machine] = { ...card, sending: true }));
      const r = await app.request<{ email: string; plan?: string }>("machine.login_code", { machine, code });
      logins.set((all) => void delete all[machine]);
      void answers.reload(machine, (m) => read(m, r.ok ? [r.result.email] : []));
      if (!r.ok) return { text: refusal(r, machine), tone: "bad" };
      const other = card.expected && card.expected !== r.result.email;
      return other ? { text: `Вошёл: ${r.result.email} — это другой аккаунт, ${shortName(card.expected!)} не изменился`, tone: "wait" } : { text: `Вошёл: ${r.result.email}`, tone: "ok" };
    },
    onRoster(r: Roster) {
      const changed = new Set(accountChanged(known, r.sessions));
      if (!changed.size || !answers.isOpen()) return;
      const fresh = new Map<string, Set<string>>();
      for (const s of r.sessions) {
        if (!changed.has(s.callsign) || typeof s.account !== "string") continue;
        const m = machineOf(s.callsign)!;
        fresh.set(m, (fresh.get(m) ?? new Set()).add(s.account));
      }
      for (const [machine, emails] of fresh) void answers.reload(machine, (m) => read(m, [...emails]));
    },
  };
}
