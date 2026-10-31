// Выпуск пульта: шесть общих пакетов web-* и пять своих (modules/): новая сессия, аккаунты, машины,
// точки, журнал флота. Порядок списка — порядок старта и разделов; гейт набора ядро проверяет при старте.
// Широкий вид: карточка, новая сессия, чат и вопрос открываются справа от списка сессий (beside).
// Вкладку «Точки» карточке даёт pult-points (createCard({ tabs })) — карточка о нём не знает.
import { manifest as alertsM, createAlerts, type BrowserPush } from "@switchboard/web-alerts";
import { manifest as askM, createAsk } from "@switchboard/web-ask";
import { manifest as boardM, createBoard } from "@switchboard/web-board";
import { manifest as cardM, createCard } from "@switchboard/web-card";
import { manifest as chatM, createChat } from "@switchboard/web-chat";
import type { AppPart, Manifest, StartOptions } from "@switchboard/web-core";
import { manifest as openM, createOpen } from "./modules/open/contract.ts";
import { manifest as accountsM, createAccounts } from "./modules/accounts/contract.ts";
import { manifest as machinesM, createMachines } from "./modules/machines/contract.ts";
import { manifest as pointsM, createPoints } from "./modules/points/contract.ts";
import { manifest as journalM, createJournal } from "./modules/journal/contract.ts";

/** Манифесты своих модулей пульта — для гейта выпуска и тестов. */
export const OWN: Manifest[] = [openM, accountsM, machinesM, pointsM, journalM];

/** Опции запуска пульта, кроме root, relayUrl и parts. */
export const PULT: Partial<StartOptions> = {
  wide: true,
  brand: "Пульт",
  beside: { card: "board", chat: "board", ask: "board", open: "board" },
};

/** Модули выпуска пульта, каждый со своей памятью; browser — API пушей (в тестах — подделка). */
export function pultParts(browser?: BrowserPush): AppPart[] {
  const points = createPoints();
  return [
    { manifest: boardM, module: createBoard() },
    { manifest: openM, module: createOpen() },
    { manifest: cardM, module: createCard({ tabs: [points.tab] }) },
    { manifest: chatM, module: createChat() },
    { manifest: askM, module: createAsk() },
    { manifest: pointsM, module: points },
    { manifest: accountsM, module: createAccounts() },
    { manifest: machinesM, module: createMachines() },
    { manifest: journalM, module: createJournal() },
    { manifest: alertsM, module: createAlerts(browser) },
  ];
}
