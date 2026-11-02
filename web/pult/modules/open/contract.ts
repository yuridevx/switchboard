// Контракт pult-open — новая сессия (пульт и телефон).
// Экран open (#open; параметры project, machine, from): имя первым полем, профиль — по умолчанию профиль сессий проекта
// на машине, папка — недавние папки проекта и machine.dirs по шагу, машина — машины проекта кнопками, слот,
// первое сообщение — необязательно. «Открыть» — session.open, «в R2» — session.r2, сообщение — session.prompt, затем card.
// Экран open.near встаёт в место card.menu карточки: «Новая задача рядом» с from — позывным сессии карточки.
import type { AppModule, Manifest } from "@switchboard/web-core";
import json from "./module.json" with { type: "json" };
import { createOpen } from "./src/open.ts";

export { createOpen };
export const manifest: Manifest = json;
export default createOpen() satisfies AppModule;
