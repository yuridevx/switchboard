// Контракт модуля Host slots v1: горячая подмена аккаунта при лимитах. Слот — ссылка на папку аккаунта;
// один аккаунт может стоять в нескольких слотах.
//   machine.slots { machine } → { slots: { имя: { account, order, wait, sessions } } }
//   slot.set { machine, slot, order } → { account }  (пустой order удаляет слот без сессий)
//   slot.swap { machine, slot, account? } → { from, to }  («Сменить сейчас»)
//   session.slot { callsign, slot | null } → { restart }
//   поля roster: slot { name, wait }, account
// Слова: no_slot, no_account, no_reserve, has_sessions; от accounts — not_logged_in, refresh_locked, slot_dir_busy.
import { make } from "./src/slots.ts";

export default make();
