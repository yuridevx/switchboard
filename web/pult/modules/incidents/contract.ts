// Контракт pult-incidents — инциденты флота (свой пакет пульта, входит в пульт и телефон).
// Экран incidents (#incidents, раздел «Инциденты»): «В сессиях» — сессии с полем roster incident { type, key }
// (обращения одного типа и ключа идут в одну сессию, host-incidents): тип, ключ, позывной, состояние; «открытые / все»;
// нажатие — карточка сессии (card). «Не доставлены» — строки журнала машины (machine.journal, kind refuse, ev incident)
// с полуночи: слово отказа и причина как записал Host; обращение ждёт на диске Host до следующего обращения или старта.
// Журнал читается при открытии экрана и на первом roster. Метка incidents.open — открытые инциденты и недоставленные.
import type { AppModule, Manifest } from "@switchboard/web-core";
import json from "./module.json" with { type: "json" };
import { createIncidents } from "./src/incidents.tsx";

export { createIncidents };

declare module "@switchboard/web-core" {
  interface Marks {
    /** открытые инциденты и недоставленные обращения */
    "incidents.open"(): number;
  }
}

export const manifest: Manifest = json;
export default createIncidents() satisfies AppModule;
