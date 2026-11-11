// Контракт web-chat — лента, ввод и переписка (общий пакет телефона и пульта).
// Кадры session.events и message; запросы session.watch, session.unwatch, session.history, session.prompt, session.files, session.call.
// Экран chat.view (sid, point?, callsign?, uuid?) — лента сессии из архива (points.history) той же свёрткой, только чтение.
// Экран chat (параметр callsign) — на весь экран или в месте карточки; над вводом — вопрос сессии (узко — полоса к экрану ask, широко — ask в месте),
// задачи Claude и идущее в фоне. Метка unread(callsign) — { count, text }. Раздел хранилища drafts.
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
