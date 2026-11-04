// Контракт модуля Host logins: аккаунты Claude на машине и слоты. Слот — ссылка на папку аккаунта; один аккаунт может стоять в нескольких слотах.
//   machine.accounts { machine, max_age? } → { accounts: { имя: { login, email?, plan?, checked?, limits } }, slots: { имя: { account, order, wait, sessions } } }
//   machine.login { machine, account } → { url };  machine.login_code { machine, account, code } → { email, plan }
//   machine.account_remove { machine, account, next? } → { wiped } — одним запросом: сменить в слотах, убрать из порядка, стереть
//   slot.set { machine, slot, order } → { account }  (пустой order удаляет слот без сессий)
//   slot.swap { machine, slot, account? } → { from, to }  («Сменить сейчас»)
//   session.slot { callsign, slot | null } → { restart } — поле обязательно
//   поля roster: slot { name, wait }, account
//   вход открытия: req.slot — имя слота; нет поля: на машине нет слотов — общий вход, а без него слот main из вошедших аккаунтов (их нет — not_logged_in), один — он, больше — slot_required
// Слова: no_account, no_slot, slot_required, not_logged_in, no_reserve, has_sessions, not_started, bad_code, login_failed,
// refresh_locked, slot_dir_busy, account_dir_busy, shutting_down; у no_slot и slot_required причина называет слоты машины.
import { make } from "./src/logins.ts";

export { make };
export type { Account, Accounts, Machine, Window } from "./src/logins.ts";
export default make();
