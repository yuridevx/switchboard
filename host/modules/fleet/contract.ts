// Контракт модуля Host fleet: сессии флота видят друг друга, пишут, открывают и ведут других. Версия 1.
// Модели каждой сессии — инструменты MCP fleet (mcp__fleet__*): list, send, answer, open, history, update, label, remove, profile, repos;
//   fleet.prompt { machine } → { text } — текст добавки к промпту для просмотра профиля;
//   open, update, remove — запросы manage, slot — вход, send и answer сессии, history — chat; проекты и имена — записи области флота у службы настроек.
//   Кадр message клиенту { from, to, text } — без ответа; текст пуша — запросом notify модулю push.
// Итог хода: ход кончился, отправитель последнего ввода — родитель сессии (поле parent от manage этой машины) и это сессия —
//   текст result родителю запросом message с report: true: кто дал задачу родителю, не меняется.
// Хранить нечего.
import { make } from "./src/fleet.ts";

export { make };
/** Что модель читает в системном промпте. */
export { prompt } from "./src/prompt.ts";
export default make().module;
