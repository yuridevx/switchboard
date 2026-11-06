// Контракт модуля Host manage v1: сессии по запросу.
//   session.open v2 { machine, name, number?, dir, mkdir?, profile?: [id], slot?, model?, effort?, fast?, style?, thinking?, resume?, fork?, point?, wing_of?: callsign }
//     → { callsign, session_id, slot }; number: true — к имени первый свободный номер на машине (disk-full-1);
//     родитель — отправитель запроса (поле parent); профиль и слот — их владельцам до старта;
//     dir — папка; mkdir: true — создать весь путь, если его нет (только по просьбе, после проверки имени);
//     wing_of — открыть ведомым этой сессии: родитель она, признак wing, имя <её имя>-wing и папка от неё, name и dir клиент не шлёт;
//     ведущего нет на машине — offline, ведомый уже есть — has_wing, ведомого у ведомого нет — bad_spec
//   session.update { callsign, model?, effort?, fast?, style?, thinking?, title? } → { now: [что подействовало сразу] }
//   session.call { callsign, method, args? } → ответ метода SDK как есть; только методы из списка открытых
//   session.reload { callsign } → ok: скилы и агенты с диска, внешние серверы кусочков заново; не живая — stopped, Claude отказал или молчит 30 с на шаге — sdk_error
//   режим разрешений: session.call setPermissionMode и listPermissionRules; нынешний режим — поле roster mode, новый процесс сессии поднимается в нём; часть есть только во время исполнения закреплённого SDK (claude-fleet ими работал): нет метода — sdk_error
//   session.spec { callsign } → { dir, model, effort, title }
//   session.stop · session.start { point? } · session.remove { callsign, after_turn? } → ok; у ведущего идут и на ведомого: стоп и снятие — он первым, точка ему не передаётся;
//     after_turn: true посреди хода — убрать после его конца: { after_turn: true }
//   поля roster: model, effort, parent, wing, mode; пара — wing && parent === ведущий, других записей пары нет; в журнал флота — ledger.add session.opened, session.removed
// Слова: unknown_method, name_taken, bad_name, bad_dir, bad_spec, open_failed, stopped, sdk_error, has_wing, offline.
import { make } from "./src/manage.ts";

export { make };
export default make();
