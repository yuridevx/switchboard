// Выпуск телефона: шесть общих пакетов web-* — следить и отвечать.
// Порядок списка — порядок старта модулей; гейт набора ядро проверяет при старте приложения.
import { manifest as alertsM, createAlerts, type BrowserPush } from "@switchboard/web-alerts";
import { manifest as askM, createAsk } from "@switchboard/web-ask";
import { manifest as boardM, createBoard } from "@switchboard/web-board";
import { manifest as cardM, createCard } from "@switchboard/web-card";
import { manifest as chatM, createChat } from "@switchboard/web-chat";
import type { AppPart } from "@switchboard/web-core";

/** Модули выпуска телефона, каждый со своей памятью; browser — API пушей (в тестах — подделка). */
export function phoneParts(browser?: BrowserPush): AppPart[] {
  return [
    { manifest: boardM, module: createBoard() },
    { manifest: cardM, module: createCard() },
    { manifest: chatM, module: createChat() },
    { manifest: askM, module: createAsk() },
    { manifest: alertsM, module: createAlerts(browser) },
  ];
}
