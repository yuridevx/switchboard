// Контракт модуля Host manage v1: сессии по запросу.
//   session.open v2 { machine, name, number?, dir, mkdir?, profile?: [id], slot?, model?, effort?, fast?, style?, thinking?, resume?, fork?, point? }
//     → { callsign, session_id, slot }; number: true — к имени первый свободный номер на машине (disk-full-1);
//     родитель — отправитель запроса (поле parent); профиль и слот — их владельцам до старта;
//     dir — папка; mkdir: true — создать весь путь, если его нет (только по просьбе, после проверки имени)
//   session.update { callsign, model?, effort?, fast?, style?, thinking?, title? } → { now: [что подействовало сразу] }
//   session.call { callsign, method, args? } → ответ метода SDK как есть; только методы из списка открытых
//   режим разрешений: session.call setPermissionMode и listPermissionRules; нынешний режим — поле roster mode, новый процесс сессии поднимается в нём; часть есть только во время исполнения закреплённого SDK (claude-fleet ими работал): нет метода — sdk_error
//   session.spec { callsign } → { dir, model, effort, title }
//   session.stop · session.start { point? } · session.remove { callsign, after_turn? } → ok;
//     after_turn: true посреди хода — убрать после его конца: { after_turn: true }
//   поля roster: model, effort, parent, mode; в журнал флота — ledger.add session.opened, session.removed
// Слова: unknown_method, name_taken, bad_name, bad_dir, bad_spec, open_failed, stopped, sdk_error.
import { make } from "./src/manage.ts";

export { make };
export default make();
