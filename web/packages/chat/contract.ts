// Контракт web-chat — лента, ввод и переписка (общий пакет телефона и пульта).
// Кадры session.events (watch Host) и message (сессия пишет владельцу); запросы session.watch,
// session.unwatch, session.history, session.prompt. Экран chat (параметр callsign) — на весь экран
// или в месте карточки; над вводом — вопрос сессии (узко — полоса к экрану ask, широко — ask в месте).
// Метка unread(callsign) — { count, text }: непрочитанные сообщения сессии. Раздел хранилища drafts.
import type { AppModule, Manifest } from "@switchboard/web-core";
import json from "./module.json" with { type: "json" };
import { createChat } from "./src/module.ts";

export { createChat };
export const manifest: Manifest = json;
export default createChat() satisfies AppModule;
