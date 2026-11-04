// Контракт records: записи области флота, общие для страниц и агентов, — проекты и имена — и цикл правки настроек.
// Запрос к службе настроек передаёт тот, кто зовёт; сама библиотека ни от чего не зависит: на страницу она входит в файл модуля, на машину — через ядро Host.
export { FLEET_PREFIX, LABELS, labelOf, setLabel, type Labels } from "./src/labels.ts";
export { addProject, arrange, dropSessions, moveProject, NONE, placeSessions, PROJECTS, projectByName, projectIdOf, removeProject, renameProject, type ProjectRec, type Section, type SessionLink } from "./src/projects.ts";
export { settings, type Ask, type AskResult, type Settings } from "./src/settings.ts";
