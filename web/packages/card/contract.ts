// Контракт web-card — карточка сессии (общий пакет телефона и пульта).
// Экран card (параметры callsign, tab: chat | info): шапка из roster, вкладки «Чат» и «Сведения».
// Чат — экран chat модуля web-chat в месте карточки.
// Широкий вид (пульт): шапка с плашкой состояния, вкладки «Чат» · вкладки выпуска · «Настройки» · «Журнал машины».
// Место card.tab: вкладка другого модуля — его экран с place: "card.tab", label и show(params) и card.tab@web-card
// в uses (так «Точки» пульта); карточка берёт вкладки через app.placed и о модулях не знает.
// Место card.menu: пункт меню другого модуля — команда с run(params) или экран с view; params.from — позывной карточки.
// Экран card.view — группа «Шапка» для панели вида другого модуля: <app.Slot screen="card.view"/>;
// app.open("card.view") — команда: возвращает встроенные настройки шапки.
import type { AppPart, Manifest } from "@switchboard/web-core";
import json from "./module.json" with { type: "json" };
import { createCard } from "./src/module.tsx";

export { createCard };
export const manifest: Manifest = json;
export default createCard satisfies AppPart["module"];
