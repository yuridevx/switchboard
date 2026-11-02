// Контракт pult-settings — настройки флота (свой пакет пульта, входит в пульт и телефон; раздел группы «Флот»).
// Экран settings (#settings?tab=…), вкладки:
//   releases — «Выпуски»: по машинам — stable частей машин и сколько машин на связи его держат, «Вернуть» прежнюю
//     сборку (releases.deploy сборкой +n−1); матрица машина × часть по keeper.state и плану (releases.list); план машины
//     сбоку — stable, закрепить версию, включить и выключить часть (releases.set); несколько машин — закрепить host разом
//     или вернуть к stable. Каталог и сборки — части с edge и stable, «Выложить» edge, модуль сборки — по имени
//     (releases.deploy; отказ — словом).
//   passes — «Пропуска»: keys.list у gate — машины и клиенты; «Пригласить» — keys.invite (ссылка #invite= устройству,
//     приглашение — программе и машине); «Отозвать» с подтверждением — keys.revoke у relay; это устройство не отзывается.
//   general — «GitHub и устройство»: приложение GitHub флота (github.app, github.setup по ?code= от GitHub), его
//     репозитории с поиском и «используются» — репозитории профилей машин (machine.profiles, «Синхронизировать»);
//     это устройство: адрес, пропуск, уведомления — метка alerts.state модуля web-alerts.
// Телефон (узкий вид) — только «Это устройство».
import type { AppModule, Manifest } from "@switchboard/web-core";
import json from "./module.json" with { type: "json" };
import { createSettings } from "./src/settings.ts";

export { createSettings };
export const manifest: Manifest = json;
export default createSettings() satisfies AppModule;
