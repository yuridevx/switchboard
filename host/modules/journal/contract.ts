// Контракт модуля Host journal. Версия 1.
//   machine.journal { machine, since: ISO-время, kind?: ["stop", "refuse", "note"], callsign?, limit }
//   → { records: [строки host и keeper машины после since, старые первыми], more }
//   more: true — следующий запрос с since = t последней записи. Нет limit или since не время — bad_frame.
// Вклад в каждую сессию — env CLAUDE_CODE_STARTUP_FAILURE_RESULTS=1; сбои из сообщений SDK — строками журнала машины.
import { make } from "./src/journal.ts";

export default make();
