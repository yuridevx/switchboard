// Контракт pult-machines — машины флота (свой пакет пульта, входит в пульт и телефон). Своего раздела нет: машины показывает страница «Аккаунты».
// Экран machine.parts (встроенный, app.Slot, параметр machine): система, keeper, части по keeper.state (.keeper@машина отвечает и при мёртвом Host),
// перезапуск упавшей части — releases.set on:false → on:true, план в «Выпусках». Ответы keeper'ов — метка keeper.answers настроек: своей копии нет; перечитать — команда keeper.reload.
// Метка machines.rows — машины строками: сначала со сбоем, потом по имени; ушедшая — с часом ухода, пока страница открыта.
// Метка machines.gone — машины, ушедшие из roster при открытой странице: машина → когда; единственный владелец.
// Метка machines.left — когда ушла машина: уход на этой странице, иначе ответ журнала флота; спросить журнал — команда machines.left.read.
import type { AppPart, Manifest } from "@switchboard/web-core";
import json from "./module.json" with { type: "json" };
import { createMachines, type MachineRowInfo } from "./src/module.tsx";

declare module "@switchboard/web-ui" {
  interface Marks {
    /** машины строками: порядок и состояние */
    "machines.rows"(): MachineRowInfo[];
    /** машина ушла из roster, пока страница открыта: когда */
    "machines.gone"(): Readonly<Record<string, number>>;
    /** когда машина ушла, если это известно */
    "machines.left"(machine: string): number | undefined;
  }
}

export { createMachines };
export type { MachineRowInfo };
export const manifest: Manifest = json;
export default createMachines satisfies AppPart["module"];
