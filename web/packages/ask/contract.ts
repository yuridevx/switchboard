// Контракт web-ask — вопросы сессий (общий пакет телефона и пульта).
// Кадры question и answered, запросы answer и question.list к модулю questions Host.
// Экран ask (параметр callsign): узко — на весь экран, широко — в месте над вводом чата.
// Метка asked(callsign) — текст первого ждущего вопроса для строки списка.
import type { AppModule, Manifest } from "@switchboard/web-core";
import json from "./module.json" with { type: "json" };
import { createAsk } from "./src/module.ts";

export type { Question } from "./src/module.ts";
export { createAsk };
export const manifest: Manifest = json;
export default createAsk() satisfies AppModule;
