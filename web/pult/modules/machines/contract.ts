// Контракт pult-machines — машины флота (свой пакет пульта, входит в пульт и телефон; раздел группы «Флот»).
// Экран machines (#machines): машины строками — лампа, имя, система, host, keeper, сессии, состояние; поиск и фильтры
// «все», «со сбоем», «ушли». Строка раскрывается в карточку: части по keeper.state (.keeper@машина отвечает и при
// мёртвом Host), перезапуск упавшей части — releases.set on:false → on:true.
// «Аккаунты машины» — экран accounts с машиной. Ушедшую машину помнит, пока страница открыта.
// Ответы keeper'ов — метка keeper.answers модуля настроек: своей копии нет.
import type { AppModule, Manifest } from "@switchboard/web-core";
import json from "./module.json" with { type: "json" };
import { createMachines } from "./src/module.tsx";

export { createMachines };
export const manifest: Manifest = json;
export default createMachines() satisfies AppModule;
