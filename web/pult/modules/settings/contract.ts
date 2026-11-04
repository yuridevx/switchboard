// Контракт pult-settings — настройки флота (свой пакет пульта, входит в пульт и телефон; раздел группы «Флот»).
// Экран settings (#settings?tab=…), вкладки:
//   releases — «Выпуски»: по машинам — stable частей машин и сколько машин на связи его держат, «Вернуть» прежнюю
//     сборку (releases.deploy сборкой +n−1); матрица машина × часть по keeper.state и плану (releases.list); план машины
//     сбоку — stable, закрепить версию, включить и выключить часть (releases.set); несколько машин — закрепить host разом
//     или вернуть к stable. Каталог и сборки — части с edge и stable, «Выложить» edge, модуль сборки — по имени
//     (releases.deploy; отказ — словом).
//   passes — «Пропуска»: keys.list у gate — машины и клиенты; «Пригласить» — keys.invite (устройству — ссылки #invite= на пульт и на телефон: page@phone,
//     приглашение — программе и машине); «Отозвать» с подтверждением — keys.revoke у relay; это устройство не отзывается.
//   general — «GitHub и устройство»: приложение GitHub флота (github.app, github.setup по ?code= от GitHub), его
//     репозитории с поиском;
//     это устройство: адрес, пропуск, уведомления — метка alerts.state модуля web-alerts.
// Телефон (узкий вид) — только «Это устройство».
// Команда keeper.reload {machine} — перечитать ответ keeper этой машины.
// Метка keeper.answers — ответы keeper'ов всех машин: get и mount; их единственный владелец; другой экран читает get(), открыт — mount().
import type { AppPart, Manifest } from "@switchboard/web-core";
import json from "./module.json" with { type: "json" };
import type { KeeperAnswers } from "./src/store.ts";
import { createSettings } from "./src/module.tsx";

export type { KeeperAnswers };
export type { KPart as KeeperPart, KState as KeeperState } from "./src/rules.ts";

declare module "@switchboard/web-core" {
  interface Marks {
    "keeper.answers"(): KeeperAnswers;
  }
}

export { createSettings };
export const manifest: Manifest = json;
export default createSettings satisfies AppPart["module"];
