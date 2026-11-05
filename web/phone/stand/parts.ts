// Стенд телефона для тестов и снимков: модули стенда пульта, входящие в телефон по своему into. Рантайм и набор компонентов стенд не поднимает.
import type { BrowserPush } from "@switchboard/web-alerts";
import type { AppPart } from "@switchboard/web-core";
import { pultParts } from "../../pult/stand/parts.ts";

const inPhone = (p: AppPart) => (p.manifest as { into?: string[] }).into?.includes("phone") && !["web-view", "web-ui"].includes(p.manifest.name);

/** Модули телефона, каждый со своей памятью; browser — API пушей (в тестах — подделка). */
export const phoneParts = (browser?: BrowserPush): AppPart[] => pultParts(browser).filter(inPhone);
