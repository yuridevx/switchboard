// Контракт модуля Host questions: вопросы сессии человеку. Версия 1.
//   question (кадр) { from, to: [кто дал задачу, зрители; perm, form и url — только клиентам], question: id, kind: ask | form | url | perm, questions | server, message, schema | url
//     | tool, input, title, description, reason, blockedPath, suggestions }
//   answer (запрос) { callsign, question, answers } | { callsign, question, content?, action? } | { callsign, question, action: allow | deny, always?, message? } → ok;
//     первый ответ выигрывает, остальные — already_answered; не знает вопроса — unknown_question; на perm отвечает только клиент-человек, иначе not_client
//   answered (кадр) { from, to, question, by, answers | action, content } или { cancelled: true }
//   question.list (запрос) { callsign } → [{ question, kind, … }] — ждущие вопросы сессии
// Решение по AskUserQuestion, запрос разрешения (decide.*) и формы MCP — только у questions; ответ за человека модуль не выбирает никогда.
// В режиме bypassPermissions (поле mode у manage) запроса нет. Отказ в разрешении и возврат плана — словами claude: «The user doesn't want to proceed with this tool use.», причина человека — « Reason: …». Что разрешить «всегда» — только то, что предложил сам SDK; у ExitPlanMode «всегда» — смена режима на acceptEdits.
import { make } from "./src/questions.ts";

export type { AnsweredFrame, AskItem, Kind, QuestionFrame } from "./src/questions.ts";
export default make();
