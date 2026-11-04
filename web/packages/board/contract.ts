// Контракт web-board — «Работа» (общий пакет телефона и пульта). Экран board (#sessions): сессии по проектам, ряд фильтров «Моё», «Всё» и свои; порядок проектов и строк — перетаскиванием.
// Проекты — запись области флота fleet.projects, формат у records. У почты: web-board.filters, .row, .pins. На устройстве: flt, collapsed, view; pins — только переход.
// Метки: mine(callsign) — почему сессия моя или ""; project.machines(номер) — машины сессий проекта; project.current() — номер открытого или последнего; project.of(callsign) — номер и имя.
// Экраны board.pin и board.unpin — команды в месте card.menu; board.assign — команда в месте open.after: Screen.run, своего вида нет.
// Нажатие строки — карточка card; «Новая» и «+» у проекта — open (с machine, dir места проекта и номером project).
import type { AppPart, Manifest } from "@switchboard/web-core";
import json from "./module.json" with { type: "json" };
import { createBoard } from "./src/module.tsx";

declare module "@switchboard/web-core" {
  interface Marks {
    /** почему сессия моя; не моя — "" */
    mine(callsign: string): string;
    /** машины сессий проекта по номеру */
    "project.machines"(project: string): string[];
    /** номер открытого или последнего проекта */
    "project.current"(): string | null;
    /** проект сессии: номер и имя; без проекта — null */
    "project.of"(callsign: string): { id: string; name: string } | null;
  }
}

export { createBoard };
export const manifest: Manifest = json;
export default createBoard satisfies AppPart["module"];
