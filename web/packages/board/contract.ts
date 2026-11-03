// Контракт web-board — «Работа» (общий пакет телефона и пульта). Экран board (#sessions): сессии по проектам — проект = projectOf ядра;
// ряд фильтров «Моё», «Всё» и свои; порядок проектов и закрепление сверху — перетаскиванием; вид списка — на устройстве; find — сессии для поиска.
// Хранит у почты (prefs сам): web-board.filters, .row, .top, .pins. На устройстве: flt, collapsed, view; pins — только переход прежних закреплений.
// Метки: mine(callsign) — почему сессия моя или ""; project.machines(project) — машины сессий проекта; project.current() — последний открытый проект.
// Экраны board.pin и board.unpin — кнопка закрепления в месте card.menu: действие с params.from, своего вида нет.
// Нажатие строки — карточка card; «Новая» и «+» у проекта — open (с machine и dir места проекта).
import type { AppModule, Manifest } from "@switchboard/web-core";
import json from "./module.json" with { type: "json" };
import { createBoard } from "./src/module.ts";

export { createBoard };
export const manifest: Manifest = json;
export default createBoard() satisfies AppModule;
