// Страница стенда: настоящий код пульта или телефона из рабочего дерева на настоящем флоте. ?app=pult|phone
// Адреса флота даёт сервер стенда из его build.json, пропуск — свой у адреса стенда (приглашение #invite=), пуши здесь не подписываются.
import { startApp } from "../../web/packages/core/contract.ts";
import { PULT, pultParts } from "../../web/pult/stand/parts.ts";
import { phoneParts } from "../../web/phone/stand/parts.ts";
import { startComments } from "./comments.ts";

const PHONE_SECTIONS = ["inbox", "board", "accounts", "machines", "profiles", "incidents", "settings"];

const app = new URLSearchParams(location.search).get("app") === "phone" ? "phone" : "pult";
const root = document.getElementById("app")!;
const events = new EventSource("/events");
events.addEventListener("reload", () => location.reload());

async function start() {
  const fleet = (await (await fetch("/fleet.json")).json()) as { fleet: string; workers: Record<string, string>; error?: string };
  if (fleet.error) {
    root.textContent = `Адреса флота не получены: ${fleet.error}`;
    return;
  }
  startComments({ app, kind: fleet.fleet, events });
  const screens = app === "pult" ? { parts: pultParts({}), ...PULT } : { parts: phoneParts({}), sections: PHONE_SECTIONS };
  startApp({ root, workers: fleet.workers, application: app, ...screens });
}
void start();
