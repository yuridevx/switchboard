// Стенд телефона в монорепо — для тестов (код оболочки — web/shell.ts — берёт только web-core): семь общих пакетов web-* и модули пульта, входящие в телефон. На странице состав и
// порядок старта даёт список сборки (build.json), а не этот файл: эталон сверяет его с into телефона.
import { manifest as alertsM, createAlerts, type BrowserPush } from "@switchboard/web-alerts";
import { manifest as askM, createAsk } from "@switchboard/web-ask";
import { manifest as boardM, createBoard } from "@switchboard/web-board";
import { manifest as cardM, createCard } from "@switchboard/web-card";
import { manifest as chatM, createChat } from "@switchboard/web-chat";
import { manifest as inboxM, createInbox } from "@switchboard/web-inbox";
import type { AppPart } from "@switchboard/web-core";
import { manifest as accountsM, createAccounts } from "../../pult/modules/accounts/contract.ts";
import { manifest as machinesM, createMachines } from "../../pult/modules/machines/contract.ts";
import { manifest as openM, createOpen } from "../../pult/modules/open/contract.ts";
import { manifest as incidentsM, createIncidents } from "../../pult/modules/incidents/contract.ts";
import { manifest as settingsM, createSettings } from "../../pult/modules/settings/contract.ts";

/** Модули выпуска телефона, каждый со своей памятью; browser — API пушей (в тестах — подделка). */
export function phoneParts(browser?: BrowserPush): AppPart[] {
  return [
    { manifest: inboxM, module: createInbox() },
    { manifest: boardM, module: createBoard() },
    { manifest: cardM, module: createCard() },
    { manifest: openM, module: createOpen() },
    { manifest: chatM, module: createChat() },
    { manifest: askM, module: createAsk() },
    { manifest: incidentsM, module: createIncidents() },
    { manifest: accountsM, module: createAccounts() },
    { manifest: machinesM, module: createMachines() },
    { manifest: settingsM, module: createSettings() },
    { manifest: alertsM, module: createAlerts(browser) },
  ];
}
