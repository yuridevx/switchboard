// Контракт web-chat — лента, ввод и переписка (общий пакет телефона и пульта).
// Кадры session.events (watch Host) и message (сессия пишет владельцу); запросы session.watch, session.unwatch, session.history,
// session.prompt, session.files, session.call. Экран chat (параметр callsign) — на весь экран или в месте карточки;
// над вводом — вопрос сессии (узко — полоса к экрану ask, широко — ask в месте), задачи Claude и идущее в фоне.
// Метка unread(callsign) — { count, text }. Раздел хранилища drafts. Экран gallery (#gallery) — все карточки на образцах SDK.
// Лента — markdown с таблицами и подсветкой кода; встроенный HTML — через санитайзер; HTML-документ и блоки html, svg — в песочнице.
// Возможности — по contract машины в roster. Устройство: state/ — состояние и чистая свёртка, cards/, composer/, docks/, panel/ — вид.
import type { AppModule, Manifest } from "@switchboard/web-core";
import json from "./module.json" with { type: "json" };
import { createChat } from "./src/module.tsx";

declare module "@switchboard/web-core" {
  interface Marks {
    unread(callsign: string): { count: number; text: string } | undefined;
  }
}

export { createChat };
export const manifest: Manifest = json;
export default createChat() satisfies AppModule;
