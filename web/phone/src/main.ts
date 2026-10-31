// Телефон: ядро и модули выпуска. Адрес relay — из сборки; ключа и секретов в сборке нет.
import { startApp } from "@switchboard/web-core";
import { phoneParts } from "../contract.ts";

declare const RELAY_URL: string;

startApp({ root: document.getElementById("app")!, relayUrl: RELAY_URL, parts: phoneParts() });
