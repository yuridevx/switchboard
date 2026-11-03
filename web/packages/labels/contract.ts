// Контракт web-labels — человеческие имена сессий и машин (общий пакет телефона и пульта).
// Метки: label.session(callsign), label.machine(machine) — что показать: { text, human } (имени нет — короткий адрес, human: false). Экран labels — окно «Имена» в месте вызывающего
// (params: callsign или machine); закрылось — на месте событие sb-close. Хранит у почты: ключ web-labels.names, prefs зовёт сам.
// Вынесен в свой модуль: имена нужны и «Работе», и карточке, а «Работа» уже зависит от карточки.
import type { AppModule, Manifest } from "@switchboard/web-core";
import json from "./module.json" with { type: "json" };
import { createLabels } from "./src/module.ts";

export { createLabels };
export const manifest: Manifest = json;
export default createLabels() satisfies AppModule;
