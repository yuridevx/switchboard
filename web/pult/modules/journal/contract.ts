// Контракт pult-journal — журнал флота (свой пакет пульта).
// Экран journal (#journal, раздел «Журнал флота»): записи ledger по дням — что случилось с машинами и сессиями,
// кто записал и по чьей команде; текст — как написал модуль-владелец события. ledger.read: limit 50,
// «Раньше» — before, машина — machine, поиск — по загруженным; пока экран открыт, при смене состава флота или возврате связи —
// after = последний id (отдельного канала нет). Журнал сессии (сбои из файлов машины) — вкладка карточки.
import type { AppPart, Manifest } from "@switchboard/web-core";
import json from "./module.json" with { type: "json" };
import { createJournal } from "./src/module.tsx";

export const manifest: Manifest = json;
export default createJournal satisfies AppPart["module"];
