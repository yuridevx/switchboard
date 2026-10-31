// Контракт модуля Host manage v1: сессии по запросу.
//   session.open { machine, name, dir, profile?, slot?, model?, effort?, fast?, style?, thinking?, resume?, fork?, point? }
//     → { callsign, session_id }; профиль и слот — их владельцам до старта
//   session.update { callsign, model?, effort?, fast?, style?, thinking?, title? } → { now: [что подействовало сразу] }
//   session.call { callsign, method, args? } → ответ метода SDK как есть; только методы из OPEN
//   session.spec { callsign } → { dir, model, effort, title }
//   session.stop · session.start { point? } · session.remove { callsign } → ok
//   поля roster: model, effort; в журнал флота — ledger.add session.opened, session.removed
// Слова: unknown_method, name_taken, bad_spec, open_failed, stopped, sdk_error.
import { manage } from "./src/manage.ts";

export { OPEN } from "./src/manage.ts";
export type { Spec } from "./src/manage.ts";
export default manage();
