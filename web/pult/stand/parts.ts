// Стенд пульта для тестов и снимков: все модули монорепо, входящие в пульт. На странице состав и порядок старта даёт build.json;
// тест сверяет этот список с into модулей.
import { manifest as alertsM, createAlerts, type BrowserPush } from "@switchboard/web-alerts";
import { manifest as askM, createAsk } from "@switchboard/web-ask";
import { manifest as boardM, createBoard } from "@switchboard/web-board";
import { manifest as cardM, createCard } from "@switchboard/web-card";
import { manifest as chatM, createChat } from "@switchboard/web-chat";
import type { AppPart } from "@switchboard/web-core";
import { manifest as inboxM, createInbox } from "@switchboard/web-inbox";
import { manifest as labelsM, createLabels } from "@switchboard/web-labels";
import { manifest as uiM } from "@switchboard/web-ui";
import { manifest as viewM } from "@switchboard/web-view";
import { manifest as accountsM, createAccounts } from "../modules/accounts/contract.ts";
import { manifest as incidentsM, createIncidents } from "../modules/incidents/contract.ts";
import { manifest as journalM, createJournal } from "../modules/journal/contract.ts";
import { manifest as machinesM, createMachines } from "../modules/machines/contract.ts";
import { manifest as openM, createOpen } from "../modules/open/contract.ts";
import { manifest as pointsM, createPoints } from "../modules/points/contract.ts";
import { manifest as profilesM, createProfiles } from "../modules/profiles/contract.ts";
import { manifest as settingsM, createSettings } from "../modules/settings/contract.ts";

export { PULT } from "../src/options.ts";

/** Модули пульта, каждый со своей памятью; browser — API пушей (в тестах — подделка). */
export function pultParts(browser?: BrowserPush): AppPart[] {
  return [
    { manifest: viewM, module: () => ({}) },
    { manifest: uiM, module: () => ({}) },
    { manifest: labelsM, module: createLabels },
    { manifest: inboxM, module: createInbox },
    { manifest: boardM, module: createBoard },
    { manifest: openM, module: createOpen },
    { manifest: cardM, module: createCard },
    { manifest: chatM, module: createChat },
    { manifest: askM, module: createAsk },
    { manifest: pointsM, module: createPoints },
    { manifest: accountsM, module: createAccounts },
    { manifest: machinesM, module: createMachines },
    { manifest: profilesM, module: createProfiles },
    { manifest: journalM, module: createJournal },
    { manifest: incidentsM, module: createIncidents },
    { manifest: settingsM, module: createSettings },
    { manifest: alertsM, module: createAlerts(browser) },
  ];
}
