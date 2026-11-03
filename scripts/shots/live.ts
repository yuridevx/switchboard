// Страница стенда: настоящий код пульта или телефона из рабочего дерева на настоящем флоте. ?app=pult|phone
// Адреса флота даёт сервер стенда из его build.json, пропуск — свой у адреса стенда (приглашение #invite=), пуши здесь не подписываются.
import { startApp } from "../../web/packages/core/contract.ts";
import { PULT, pultParts } from "../../web/pult/stand/parts.ts";
import { phoneParts } from "../../web/phone/stand/parts.ts";
import { startComments } from "./comments.ts";

const app = new URLSearchParams(location.search).get("app") === "phone" ? "phone" : "pult";
const root = document.getElementById("app")!;
const events = new EventSource("/events");
events.addEventListener("reload", () => location.reload());

void (async () => {
  const f = (await (await fetch("/fleet.json")).json()) as { fleet: string; workers: Record<string, string>; error?: string };
  if (f.error) {
    root.textContent = `Адреса флота не получены: ${f.error}`;
    return;
  }
  startComments({ app, kind: f.fleet, events });
  startApp({
    root,
    workers: f.workers,
    application: app,
    ...(app === "pult" ? { parts: pultParts({}), ...PULT } : { parts: phoneParts({}), sections: ["inbox", "board", "accounts", "machines", "profiles", "incidents", "settings"] }),
  });
})();
