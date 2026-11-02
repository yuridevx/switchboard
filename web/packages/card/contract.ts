// Контракт web-card — карточка сессии (общий пакет телефона и пульта).
// Экран card (параметры callsign, tab: chat | info): шапка из roster, вкладки «Чат» и «Сведения».
// Чат — экран chat модуля web-chat в месте карточки.
// Широкий вид (пульт): шапка с плашкой состояния, вкладки «Чат» · вкладки выпуска · «Настройки» · «Журнал машины».
// Место card.tab: вкладка другого модуля — его экран с place: "card.tab", label и show(params) и card.tab@web-card
// в uses (так «Точки» пульта); карточка берёт вкладки через app.placed и о модулях не знает.
import type { AppModule, Manifest } from "@switchboard/web-core";
import json from "./module.json" with { type: "json" };
import { createCard } from "./src/module.ts";

export { createCard };
export const manifest: Manifest = json;
export default createCard() satisfies AppModule;
