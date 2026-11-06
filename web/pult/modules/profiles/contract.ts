// Контракт pult-profiles — экран profiles (#profiles, раздел группы «Флот»): только просмотр всего в профиле, без живых данных.
// Кусочки по репозиториям, поиск по именам внутри них, итог списком имён-ссылок и девять постоянных вкладок: что получит сессия считает система. Тексты файлов — по нажатию. Своих данных нет.
import type { AppPart, Manifest } from "@switchboard/web-core";
import json from "./module.json" with { type: "json" };
import { createProfiles } from "./src/module.tsx";

export { createProfiles };
export const manifest: Manifest = json;
export default createProfiles satisfies AppPart["module"];
