// Контракт модуля Host accounts v2: аккаунты Claude на машине; слот — ссылка на папку аккаунта.
//   machine.accounts { machine, max_age? } → { accounts: { имя: { email, plan, login, links, checked, limits } } }
//   machine.login { machine, account } → { url };  machine.login_code { machine, account, code } → { email, plan }
//   machine.account_remove { machine, account } → { wiped }
//   account.usage { account, src, at, windows } — наблюдение окон (slots: src "event"; пульт: имя машины)
//   account.place v2 { dir, account | null } → { from } — ссылка слота dir на папку аккаунта или снять её (зовёт slots);
//     под блокировкой обновления входа claude в папке прежнего аккаунта
// Слова: no_account, not_started, bad_code, not_logged_in, in_slot, refresh_locked, slot_dir_busy.
import { make } from "./src/accounts.ts";

export type { Account, Accounts, Window } from "./src/accounts.ts";
export default make();
