// Контракт web-board — «Работа» (общий пакет телефона и пульта). Экран board (#sessions): сессии по проектам —
// проект = последнее имя папки поля dir; «Моё / Всё»; внутри проекта группы по профилям или машинам, в группе — дерево
// по parent; машины проекта — выбор устройства. sub — проекты в колонке разделов, find — проекты и сессии для Ctrl K.
// Метки: mine(callsign) — почему сессия моя или ""; project(callsign) — проект; project.machines(project) — машины
// проекта; project.current() — открытый или последний проект. Нажатие строки — карточка card; «Новая задача» — open.
import type { AppModule, Manifest } from "@switchboard/web-core";
import json from "./module.json" with { type: "json" };
import { createBoard } from "./src/module.ts";

export { createBoard };
export const manifest: Manifest = json;
export default createBoard() satisfies AppModule;
