// Контракт модуля Host fleet: сессии флота видят друг друга, пишут, открывают и ведут других. Версия 1.
//   message (запрос) { to: callsign, text, report? } — во ввод адресата тегом <fleet-message from="…"> с priority "next";
//     отправитель — от Host или relay; ответ ok — сообщение во вводе. Слово: offline — адресата нет.
//     report: true — итог хода дочери или уведомление (конец фонового запуска shell): отправитель последнего ввода
//     у адресата не меняется — его вопросы уходят тому, кто дал ему задачу.
//   message (кадр клиенту) { from, to: "phone", text } — без ответа; текст пуша — запросом notify модулю push.
//   Итог хода: ход кончился, отправитель последнего ввода — родитель сессии (поле parent от manage этой машины) и это сессия —
//     текст result родителю тем же message.
// Модели каждой сессии — инструменты MCP fleet (mcp__fleet__*): list, send, answer, open, history, update, remove;
// open, update, remove — запросы manage, history — chat. Хранить нечего.
import { make } from "./src/fleet.ts";

export default make().module;
