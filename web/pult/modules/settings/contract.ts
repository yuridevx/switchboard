// Контракт pult-settings — настройки флота (свой пакет пульта, входит в пульт и телефон; раздел группы «Флот»).
// Экран settings (#settings?tab=…), вкладки:
//   releases — «Выпуски»: по машинам — stable частей машин и сколько машин на связи его держат, «Вернуть» прежнюю
//     сборку (releases.deploy сборкой +n−1); матрица машина × часть по keeper.state и плану (releases.list); план машины
//     сбоку — stable, закрепить версию, включить и выключить часть (releases.set); несколько машин — закрепить host разом
//     или вернуть к stable. Каталог и сборки — части с edge и stable, «Выложить» edge, модуль сборки — по имени
//     (releases.deploy; отказ — словом).
//   passes — «Пропуска»: keys.list у gate — машины и клиенты; «Пригласить» — keys.invite (устройству — ссылки #invite= на пульт и на телефон: page@phone,
//     приглашение — программе и машине); «Отозвать» с подтверждением — keys.revoke у relay; это устройство не отзывается.
//   rules — «Правила модели»: правила замены прокси — ключ proxy.rules области global у prefs (prefs.set; prefs.changed доводит их до прокси машин);
//     правка прямо в наборе, проверка тем же пакетом rules, что у прокси: на своём тексте или на вызове из архива (параметр call — sid/uuid:
//     points.history — system вызова и записи до него, имя сессии — points.list); назад — к той же точке. Сохранение — одно, всего набора.
//   general — «GitHub и устройство»: приложение GitHub флота (github.app, github.setup по ?code= от GitHub), его
//     репозитории с поиском;
//     это устройство: адрес, пропуск, уведомления — метка alerts.state модуля web-alerts.
// Телефон (узкий вид) — только «Это устройство».
// Команды keeper.open и keeper.close — чужой экран открыт и закрыт: ответы держать свежими; keeper.reload {machine} — перечитать ответ этой машины.
// Метка keeper.answers — ответы keeper'ов всех машин, только данные; их единственный владелец.
import type { AppPart, Manifest } from "@switchboard/web-core";
import json from "./module.json" with { type: "json" };
import type { KeeperAnswers } from "./src/state.ts";
import { createSettings } from "./src/module.tsx";

export type { KeeperAnswers };
export type { KPart as KeeperPart, KState as KeeperState } from "./src/rules.ts";

declare module "@switchboard/web-ui" {
  interface Marks {
    "keeper.answers"(): KeeperAnswers;
  }
}

export { createSettings };
export const manifest: Manifest = json;
export default createSettings satisfies AppPart["module"];
