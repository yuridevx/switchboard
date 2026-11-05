// Набор стенда: те же файлы модулей и порядок, что в сборке пульта; web-core — сам стенд, уведомления — на браузере теста.
import * as alerts from "@switchboard/web-alerts";
import type { BrowserPush } from "@switchboard/web-alerts";
import * as ask from "@switchboard/web-ask";
import * as board from "@switchboard/web-board";
import * as card from "@switchboard/web-card";
import * as chat from "@switchboard/web-chat";
import type { AppPart } from "@switchboard/web-core";
import * as inbox from "@switchboard/web-inbox";
import * as labels from "@switchboard/web-labels";
import { manifest as ui } from "@switchboard/web-ui";
import { manifest as view } from "@switchboard/web-view";
import * as accounts from "../modules/accounts/contract.ts";
import * as incidents from "../modules/incidents/contract.ts";
import * as journal from "../modules/journal/contract.ts";
import * as machines from "../modules/machines/contract.ts";
import * as open from "../modules/open/contract.ts";
import * as points from "../modules/points/contract.ts";
import * as profiles from "../modules/profiles/contract.ts";
import * as settings from "../modules/settings/contract.ts";

export { PULT } from "../src/options.ts";

const MODULES = [labels, journal, settings, ask, chat, card, incidents, open, profiles, board, accounts, machines, points, inbox];

export function pultParts(browser?: BrowserPush): AppPart[] {
  return [
    { manifest: view, module: () => ({}) },
    { manifest: ui, module: () => ({}) },
    { manifest: alerts.manifest, module: alerts.createAlerts(browser) },
    ...MODULES.map((m) => ({ manifest: m.manifest, module: m.default })),
  ];
}
