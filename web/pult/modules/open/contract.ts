// Контракт pult-open — новая сессия (свой пакет пульта).
// Экран open (#open, раздел «＋ Новая сессия»): машина — из roster с session.open в contract; слоты, лимиты
// аккаунтов и профили — у их владельцев на этой машине; папки — machine.dirs по шагу, «создать» — machine.mkdir.
// Одна кнопка — один session.open; «в R2» выключено, включили — после reply ещё session.r2 { on: true }.
// После reply — карточка новой сессии (card@web-card).
import type { AppModule, Manifest } from "@switchboard/web-core";
import json from "./module.json" with { type: "json" };
import { createOpen } from "./src/open.ts";

export { createOpen };
export const manifest: Manifest = json;
export default createOpen() satisfies AppModule;
