// Контракт web-card — карточка сессии (общий пакет телефона и пульта).
// Экран card (параметры callsign, tab: chat | info): шапка из roster, вкладки «Чат» и «Сведения».
// Чат — экран chat модуля web-chat в месте карточки.
// Широкий вид (пульт): шапка с плашкой состояния, вкладки «Чат» · вкладки выпуска · «Настройки» · «Журнал машины».
// Вкладку другого модуля выпуск передаёт в createCard({ tabs: [{ key, label, show, mount }] }) — модуль кладёт
// свой экран в место карточки (так «Точки» пульта); карточка о нём не знает.
import type { AppModule, Manifest } from "@switchboard/web-core";
import json from "./module.json" with { type: "json" };
import { createCard } from "./src/module.ts";

export { createCard };
export type { CardTab } from "./src/module.ts";
export const manifest: Manifest = json;
export default createCard() satisfies AppModule;
