// Контракт web-board — «Работа» (общий пакет телефона и пульта). Экран board (#sessions): сессии по проектам — проект = projectOf набора;
// ряд фильтров «Моё», «Всё» и свои; порядок проектов и закрепление сверху — перетаскиванием; вид списка — на устройстве; find — сессии для поиска.
// Хранит у почты (prefs сам): web-board.filters, .row, .top, .pins. На устройстве: flt, collapsed, view; pins — только переход прежних закреплений.
// Метки: mine(callsign) — почему сессия моя или ""; project.machines(project) — машины сессий проекта; project.current() — последний открытый проект.
// Экраны board.pin и board.unpin — команды в месте card.menu: Screen.run с params.from, своего вида нет.
// Нажатие строки — карточка card; «Новая» и «+» у проекта — open (с machine и dir места проекта).
import type { AppModule, Manifest } from "@switchboard/web-core";
import json from "./module.json" with { type: "json" };
import { createBoard } from "./src/module.tsx";

declare module "@switchboard/web-core" {
  interface Marks {
    /** почему сессия моя; не моя — "" */
    mine(callsign: string): string;
    /** машины сессий проекта */
    "project.machines"(project: string): string[];
    /** открытый или последний проект */
    "project.current"(): string | null;
  }
}

export { createBoard };
export const manifest: Manifest = json;
export default createBoard() satisfies AppModule;
