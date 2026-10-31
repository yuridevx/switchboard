// Контракт модуля Host slots v1: горячая подмена аккаунта при лимитах.
//   machine.slots { machine } → { slots: { имя: { account, order, wait, sessions } } }
//   slot.set { machine, slot, order } → { account }  (пустой order удаляет слот без сессий)
//   slot.swap { machine, slot, account? } → { from, to }  («Сменить сейчас»)
//   session.slot { callsign, slot | null } → { restart }
//   поля roster: slot { name, wait }, account
// Слова: no_slot, no_account, no_reserve, has_sessions.
import { make } from "./src/slots.ts";

export default make();
