// Набор стенда телефона: стенд пульта по into манифестов; состав записан один раз. Библиотеки страницы приносит сам стенд.
import type { BrowserPush } from "@switchboard/web-alerts";
import type { AppPart } from "@switchboard/web-core";
import { pultParts } from "../../pult/stand/parts.ts";

const LIBRARIES = ["web-view", "web-ui"];

export function phoneParts(browser?: BrowserPush): AppPart[] {
  return pultParts(browser).filter(({ manifest }) => (manifest as { into?: string[] }).into?.includes("phone") && !LIBRARIES.includes(manifest.name));
}
