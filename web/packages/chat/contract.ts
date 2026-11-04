// Контракт web-chat — лента, ввод и переписка (общий пакет телефона и пульта).
// Кадры session.events (watch Host) и message (сессия пишет владельцу); запросы session.watch, session.unwatch, session.history,
// session.prompt, session.files, session.call. Экран chat (параметр callsign) — на весь экран или в месте карточки;
// над вводом — вопрос сессии (узко — полоса к экрану ask, широко — ask в месте), задачи Claude и идущее в фоне.
// Метка unread(callsign) — { count, text }. Раздел хранилища drafts.
// Лента — markdown с таблицами и подсветкой кода; встроенный HTML — через санитайзер; HTML-документ и блоки html, svg — в песочнице.
// session.call: «/btw вопрос» — вопрос сбоку, вывод фоновой команды, снятие из очереди, разделы панели контекста; метода нет на Host — нет раздела.
// Возможности — по contract машины в roster. Устройство: state/ — состояние и чистая свёртка, cards/, composer/, docks/, panel/ — вид.
import type { AppPart, Manifest } from "@switchboard/web-core";
import type { ModelInfo } from "@switchboard/web-ui";
import json from "./module.json" with { type: "json" };
import { createChat } from "./src/module.tsx";

declare module "@switchboard/web-ui" {
  interface Marks {
    unread(callsign: string): { count: number; text: string } | undefined;
    /** Модели сессии (supportedModels): один запрос на разговор, спрашивает команда models.load; нет ответа — null или undefined. */
    models(callsign: string): ModelInfo[] | null | undefined;
  }
}

export { createChat };
export const manifest: Manifest = json;
export default createChat satisfies AppPart["module"];
