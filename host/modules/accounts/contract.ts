// Контракт модуля Host accounts v1: аккаунты Claude на машине.
//   machine.accounts { machine, max_age? } → { accounts: { имя: { email, plan, login, lent, checked, limits } } }
//   machine.login { machine, account } → { url };  machine.login_code { machine, account, code } → { email, plan }
//   machine.account_remove { machine, account } → { wiped }
//   account.usage { account, src, at, windows } — наблюдение окон (slots: src "event"; пульт: имя машины)
//   account.place { account, dir | null } → { returned?, refreshed } — вход в папку слота или домой (зовёт slots)
// Слова: no_account, not_started, bad_code, not_logged_in, in_slot.
import { make } from "./src/accounts.ts";

export type { Account, Accounts, Window } from "./src/accounts.ts";
export default make();
