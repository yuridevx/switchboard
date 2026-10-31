// Контракт модуля Host fleet: переписка сессий по позывным. Версия 1.
//   message (запрос) { to: callsign, text, wait? } — во ввод адресата тегом <fleet-message from="…"> с priority "next";
//     ответ ok — сообщение во вводе; с wait: true — после конца хода, взявшего его: { text: result }.
//     Слова: offline — адресата нет; turn_failed — ход с сообщением кончился ошибкой или оборвался.
//   message (кадр клиенту) { from, to: "phone", text } — без ответа; текст пуша — запросом notify модулю push.
// Модели каждой сессии — инструменты MCP fleet: list, send, answer (mcp__fleet__*). Хранить нечего.
import { make } from "./src/fleet.ts";

export default make().module;
