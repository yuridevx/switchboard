// Контракт web-ask — вопросы сессий (общий пакет телефона и пульта).
// Кадры question и answered, запросы answer и question.list к модулю questions Host.
// Экран ask (параметр callsign): узко — на весь экран, широко — в месте над вводом чата (app.Slot).
// Метка asked(callsign) — текст первого ждущего вопроса для строки списка.
import type { AppModule, Manifest } from "@switchboard/web-core";
import json from "./module.json" with { type: "json" };
import { createAsk } from "./src/module.tsx";

declare module "@switchboard/web-core" {
  interface Marks {
    asked(callsign: string): string | undefined;
  }
}

export type { Question } from "./src/module.tsx";
export { createAsk };
export const manifest: Manifest = json;
export default createAsk() satisfies AppModule;
