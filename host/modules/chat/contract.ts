// Контракт модуля Host chat: разговор с сессией. Версия 2. Запросы адресованы callsign сессии, message — полем to.
// Ввод:
//   rooms.message (кадр без id, имя Worker'а rooms) { to, from, text } — человек написал в чат Telegram: во ввод тегом <fleet-message>; пока сессия спрашивает этот адрес, текст — ответ на вопрос; сессия остановлена — запрос notify в тот же чат; сессии нет — строка журнала
//   session.prompt { callsign, uuid?, text, attachments?: [{ name, media_type, data(base64) }] } → { uuid }; слова: bad_attachment, stopped
//   message { to, text, report? } — сообщение другой сессии во ввод тегом <fleet-message>; report — итог хода дочери, кто дал задачу, остаётся прежним; слово offline
// Чтение:
//   session.history { callsign, before: uuid | null, limit } → { messages: SessionMessage[], more }
//   session.files { callsign, query, limit } → ["src/worker.ts", …] — пути от папки сессии; слово timeout
// Лента:
//   session.watch / session.unwatch { callsign } — зритель — from запроса; ответ ok
//   session.events { from, to: [зрители], seq, events: [сообщения SDK как есть] } — кадр без ответа, пачка за 100 мс
// Вопросы:
//   question (кадр) { from, to: [кто дал задачу, зрители; perm, form и url — только клиентам], question: id, kind: ask | form | url | perm, questions | server, message, schema | url
//     | tool, input, title, description, reason, blockedPath, suggestions }; сессии-адресату — во ввод тегом <fleet-question>
//   answer { callsign, question, answers } | { callsign, question, content?, action? } | { callsign, question, action: allow | deny, always?, message? } → ok;
//     первый ответ выигрывает, остальные — already_answered; не знает вопроса — unknown_question; на perm отвечает только клиент-человек, иначе not_client
//   answered (кадр) { from, to, question, by, answers | action, content } или { cancelled: true }
//   question.list { callsign } → [{ question, kind, … }] — ждущие вопросы сессии
// Решение по AskUserQuestion, запрос разрешения (decide.*) и формы MCP — только здесь; ответ за человека модуль не выбирает никогда.
// В режиме bypassPermissions (поле mode у manage) запроса нет. Отказ в разрешении и возврат плана — словами claude: «The user doesn't want to proceed with this tool use.», причина человека — « Reason: …». Что разрешить «всегда» — только то, что предложил сам SDK; у ExitPlanMode «всегда» — смена режима на acceptEdits.
import { make } from "./src/chat.ts";

export { make };
/** Что видит модель адресата: тег сообщения и задача от родителя. */
export { task, wrap } from "./src/chat.ts";
export default make();
