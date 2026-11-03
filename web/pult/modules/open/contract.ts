// Контракт pult-open — новая сессия (пульт и телефон), экран open (#open; параметры machine и dir — место, необязательно).
// Сверху — где: «Недавние» и «Папка на машине» (machine.dirs по шагу, частота — из roster). Снизу — имя (обязательно, подставлено из папки),
// профиль и модель · усилие · слот — ответы владельцев выбранной машины, точки в R2 (выключены), задача — необязательно.
// «Открыть» — session.open, «в R2» — session.r2, задача — session.prompt, затем card.
import type { AppModule, Manifest } from "@switchboard/web-core";
import json from "./module.json" with { type: "json" };
import { createOpen } from "./src/open.tsx";

export { createOpen };
export const manifest: Manifest = json;
export default createOpen() satisfies AppModule;
