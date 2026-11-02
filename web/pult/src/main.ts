// Пульт: ядро и модули выпуска. Адрес relay — из сборки; ключа и секретов в сборке нет.
import { startApp } from "@switchboard/web-core";
import { PULT, pultParts } from "../contract.ts";

declare const RELAY_URL: string;
declare const WORKERS: Record<string, string>;

// GitHub вернул браузер с ?code= после создания приложения флота — экран машин его сохранит
if (new URLSearchParams(location.search).has("code") && !location.hash) history.replaceState(null, "", location.pathname + location.search + "#machines");

startApp({ root: document.getElementById("app")!, relayUrl: RELAY_URL, workers: WORKERS, parts: pultParts(), ...PULT });
