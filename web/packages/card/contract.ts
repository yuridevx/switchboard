// Контракт web-card — карточка сессии (общий пакет телефона и пульта).
// Экран card (параметры callsign, tab: chat | info): шапка из roster, вкладки «Чат» и «Сведения».
// Чат — экран chat модуля web-chat в месте карточки. Свои вкладки пульт кладёт в место так же — через app.open.
import type { AppModule, Manifest } from "@switchboard/web-core";
import json from "./module.json" with { type: "json" };
import { createCard } from "./src/module.ts";

export { createCard };
export const manifest: Manifest = json;
export default createCard() satisfies AppModule;
