// Пульт в монорепо — для стенда и тестов: шесть общих пакетов web-* и пять своих (modules/): новая сессия, аккаунты,
// машины, точки, журнал флота. На странице состав и порядок старта даёт список сборки (build.json), а не этот файл:
// эталон сверяет, что здесь те же модули, что в into пульта. Опции оболочки — src/options.ts.
// Вкладка «Точки» — экран pult-points в месте card.tab карточки: карточка о нём не знает.
import { manifest as alertsM, createAlerts, type BrowserPush } from "@switchboard/web-alerts";
import { manifest as askM, createAsk } from "@switchboard/web-ask";
import { manifest as boardM, createBoard } from "@switchboard/web-board";
import { manifest as cardM, createCard } from "@switchboard/web-card";
import { manifest as chatM, createChat } from "@switchboard/web-chat";
import type { AppPart, Manifest } from "@switchboard/web-core";
import { manifest as openM, createOpen } from "./modules/open/contract.ts";
import { manifest as accountsM, createAccounts } from "./modules/accounts/contract.ts";
import { manifest as machinesM, createMachines } from "./modules/machines/contract.ts";
import { manifest as pointsM, createPoints } from "./modules/points/contract.ts";
import { manifest as journalM, createJournal } from "./modules/journal/contract.ts";

/** Манифесты своих модулей пульта — для гейта выпуска и тестов. */
export const OWN: Manifest[] = [openM, accountsM, machinesM, pointsM, journalM];

/** Опции оболочки пульта: вид, имя, порядок разделов, beside. */
export { PULT } from "./src/options.ts";

/** Модули выпуска пульта, каждый со своей памятью; browser — API пушей (в тестах — подделка). */
export function pultParts(browser?: BrowserPush): AppPart[] {
  return [
    { manifest: boardM, module: createBoard() },
    { manifest: openM, module: createOpen() },
    { manifest: cardM, module: createCard() },
    { manifest: chatM, module: createChat() },
    { manifest: askM, module: createAsk() },
    { manifest: pointsM, module: createPoints() },
    { manifest: accountsM, module: createAccounts() },
    { manifest: machinesM, module: createMachines() },
    { manifest: journalM, module: createJournal() },
    { manifest: alertsM, module: createAlerts(browser) },
  ];
}
