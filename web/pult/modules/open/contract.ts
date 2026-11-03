// Контракт pult-open — новая сессия (пульт и телефон), экран open (#open; параметры machine и dir — место; остальные параметры страница не читает и отдаёт вставкам места).
// Сверху — имя, первое и пустое. Ниже — машины и адрес: одно поле на путь, поиск и создание; machine.dirs только подсказывает. «Открыть» — session.open с mkdir, решает машина.
// Место open.after: команды других модулей (Screen.run) зовутся сразу после открытия с параметрами страницы и callsign новой сессии. Затем «в R2» — session.r2, задача — session.prompt, карточка card.
// Хранит у почты: pult-open.recent — 5 своих последних мест.
import type { AppModule, Manifest } from "@switchboard/web-core";
import json from "./module.json" with { type: "json" };
import { createOpen } from "./src/module.tsx";

export { createOpen };
export const manifest: Manifest = json;
export default createOpen() satisfies AppModule;
