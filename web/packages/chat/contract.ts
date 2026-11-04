// Снесено: экран отвечает словом до новой реализации.
import type { AppPart, Manifest } from "@switchboard/web-core";
import type { ModelInfo } from "@switchboard/web-ui";
import json from "./module.json" with { type: "json" };

declare module "@switchboard/web-ui" {
  interface Marks {
    unread(callsign: string): { count: number; text: string } | undefined;
    /** Модели сессии (supportedModels): один запрос на разговор, спрашивает команда models.load; нет ответа — null или undefined. */
    models(callsign: string): ModelInfo[] | null | undefined;
  }
}

const Gone = () => "снесено";
export const createChat: AppPart["module"] = () => ({
  screens: { chat: { label: "Чат", path: "chat", view: Gone, head: () => ({ title: "снесено" }) } },
});
export const manifest: Manifest = json;
export default createChat;
