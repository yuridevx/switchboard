// Контракт модуля Host fleet: сессии флота видят друг друга, пишут, открывают и ведут других. Версия 1.
// Модели каждой сессии — инструменты MCP fleet (mcp__fleet__*): list, send, answer, open, history, update, label, remove, profile, repos;
//   fleet.prompt { machine } → { text } — текст добавки к промпту для просмотра профиля;
//   open, update, remove — запросы manage, slot — вход, send и answer сессии, history — chat; проекты и имена — записи области флота у службы настроек.
//   history с people — переписка с людьми из разговора сессии: своего хранилища нет, читается session.history одним запросом.
//   Кадр message клиенту { from, to, text } — без ответа; текст пуша и чатов Telegram — запросом notify модулю push, его undelivered модель видит в ответе send.
// Итог хода: ход кончился, отправитель последнего ввода — родитель сессии (поле parent от manage этой машины) и это сессия —
//   текст result родителю запросом message с report: true: кто дал задачу родителю, не меняется.
// Пара: ведомый виден и адресуем только своему ведущему и только в list, send, answer, history; остальным — pair_inside, а в list ведущий несёт поле pair с настройками ведомого без адреса.
//   open и update + wing { profile, model, effort, slot }; update wing: null снимает ведомого. Ведомому нет сервера fleet и добавки к промпту.
//   Ведущему запросом message с report: true — весть о ведомом (on.open при start spawn) и слово об обрыве (on.close посреди хода, начатого ведущим).
// Сервер MCP флота: пропуск сессии — один раз, keys.invite с адресом сессии и gate.redeem; лежит в разделе сессии; mcpServers.switchboard —
//   HTTP к Worker mcp с этим пропуском (ведомому нет). session.remove — keys.revoke пропуска. Хранит: раздел сессии — {kid, key} пропуска.
import { make } from "./src/fleet.ts";

export { make };
/** Что модель читает в системном промпте. */
export { prompt } from "./src/prompt.ts";
export default make().module;
