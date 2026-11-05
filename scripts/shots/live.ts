// Настоящая страница стенда: все модули из дерева на адресах флота, наложение комментариев. Сервер — dev.mjs.
import { startApp } from "../../web/packages/core/contract.ts";
import { PULT, pultParts } from "../../web/pult/stand/parts.ts";
import { phoneParts } from "../../web/phone/stand/parts.ts";
import { startComments } from "./comments.ts";

const PHONE_SECTIONS = ["inbox", "board", "accounts", "machines", "profiles", "incidents", "settings"];
const app = new URLSearchParams(location.search).get("app") === "phone" ? "phone" : "pult";

const events = new EventSource("/events");
events.addEventListener("reload", () => location.reload());

void (async () => {
  const root = document.getElementById("app")!;
  const r = await fetch("/fleet.json");
  const { fleet, workers, error } = (await r.json()) as { fleet: string; workers: Record<string, string>; error?: string };
  if (error) return void (root.textContent = `Адреса флота не получены: ${error}`);
  startComments({ app, kind: fleet, events });
  startApp({ root, workers, application: app, ...(app === "pult" ? { parts: pultParts(), ...PULT } : { parts: phoneParts(), sections: PHONE_SECTIONS }) });
})();
