// Контракт pult-profiles — экран profiles (#profiles, раздел группы «Флот»): профили всех машин одной таблицей.
// Строка: имя, описание, модель · усилие, на скольких машинах, сколько сессий, конфликт; раскрывается — машины, сессии, файлы конфликта.
// Поиск, отбор «конфликты N». Одна кнопка «Синхронизировать» — machine.profiles { sync: true } по всем машинам. Своих данных нет.
import type { AppModule, Manifest } from "@switchboard/web-core";
import json from "./module.json" with { type: "json" };
import { createProfiles } from "./src/module.tsx";

export { createProfiles };
export const manifest: Manifest = json;
export default createProfiles() satisfies AppModule;
