// Контракт модуля Host questions: вопросы сессии человеку. Версия 1.
//   question (кадр) { from, to: [кто дал задачу, зрители], question: id, kind: ask | form | url, questions | server, message, schema | url }
//   answer (запрос) { callsign, question, answers } | { callsign, question, content?, action? } → ok;
//     первый ответ выигрывает, остальные — already_answered; не знает вопроса — unknown_question
//   answered (кадр) { from, to, question, by, answers | action, content } или { cancelled: true }
//   question.list (запрос) { callsign } → [{ question, kind, … }] — ждущие вопросы сессии
// Решение по AskUserQuestion и формы MCP — только у questions; ответ за человека модуль не выбирает никогда.
import { make } from "./src/questions.ts";

export type { AnsweredFrame, AskItem, Kind, QuestionFrame } from "./src/questions.ts";
export default make();
