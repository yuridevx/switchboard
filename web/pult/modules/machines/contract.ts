// Контракт pult-machines — машины флота (свой пакет пульта).
// Экран machines (#machines): машины из roster — система, Host, SDK, процессы (machine.state), профили
// и синхронизация памяти (machine.profiles), обновление Host до новейшего выпуска в R2 (machine.upgrade;
// «есть новая версия» — ответ машины на dryRun, пульт версии не сравнивает), приложение GitHub флота
// (github.app — есть или форма manifest; github.setup — code из возврата GitHub в адресе страницы).
// «+ Аккаунт» — экран accounts с машиной. Машин без связи не помнит: их история — в журнале флота.
import type { AppModule, Manifest } from "@switchboard/web-core";
import json from "./module.json" with { type: "json" };
import { createMachines } from "./src/machines.ts";

export { createMachines };
export const manifest: Manifest = json;
export default createMachines() satisfies AppModule;
