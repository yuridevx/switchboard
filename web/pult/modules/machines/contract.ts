// Контракт pult-machines — машины флота (свой пакет пульта).
// Экран machines (#machines): машины из roster — система, keeper, части машины с версиями и состоянием
// (keeper.state от .keeper@машина: keeper отвечает и при мёртвом Host), профили и синхронизация памяти
// (machine.profiles), приложение GitHub флота (github.app — есть или форма manifest; github.setup — code из возврата GitHub в адресе страницы).
// «+ Аккаунт» — экран accounts с машиной. Машин без связи не помнит: их история — в журнале флота.
import type { AppModule, Manifest } from "@switchboard/web-core";
import json from "./module.json" with { type: "json" };
import { createMachines } from "./src/machines.ts";

export { createMachines };
export const manifest: Manifest = json;
export default createMachines() satisfies AppModule;
