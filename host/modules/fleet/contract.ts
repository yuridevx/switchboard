// Контракт модуля Host fleet: сессии флота видят друг друга, пишут, открывают и ведут других. Версия 1.
//   message (запрос) { to: callsign, text } — во ввод адресата тегом <fleet-message from="…"> с priority "next";
//     отправитель — от Host или relay; ответ ok — сообщение во вводе. Слово: offline — адресата нет.
//   message (кадр клиенту) { from, to: "phone", text } — без ответа; текст пуша — запросом notify модулю push.
//   Итог хода: ход кончился, отправитель последнего ввода — родитель сессии (поле parent в roster) и это сессия —
//     текст result родителю тем же message.
// Модели каждой сессии — инструменты MCP fleet (mcp__fleet__*): list, send, answer, open, history, update, remove;
// open, update, remove — запросы manage, history — chat. Хранить нечего.
import { make } from "./src/fleet.ts";

export default make().module;
