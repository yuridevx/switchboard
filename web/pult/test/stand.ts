// Стенд пульта: страница happy-dom, поддельный relay с флотом home из дизайна и ответами владельцев.
// Контракт машины — provides всех модулей Host монорепо, как Host шлёт его в hello.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRepo } from "@switchboard/manifest-gate";
import { memoryStore, type Roster } from "@switchboard/web-core";
import { PULT, pultParts } from "../contract.ts";
import { FakeRelay, flush, stand } from "../../packages/core/stand/app.ts";
import { fakeBrowser } from "../../packages/alerts/stand/fakes.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const repo = loadRepo(root);

/** Контракт Host машины: provides ядра Host и всех его модулей. */
export const HOST: Record<string, number> = Object.assign({}, ...repo.filter((m) => m.name === "host" || m.name.startsWith("host-")).map((m) => m.provides));
/** Контракт Worker-модуля монорепо. */
export const worker = (name: string) => ({ name, contract: repo.find((m) => m.name === name)!.provides });

export const KEY = "client.panel-desk.k3f1.Qa7sig";

/** Флот home из дизайна пульта: laptop и pc, шесть сессий, Worker-модули push, points, ledger, github. */
export function fleetRoster(over: Partial<Roster> = {}): Roster {
  return {
    type: "roster",
    machines: [
      { machine: "laptop", since: Date.UTC(2026, 9, 31, 9, 12), proto: 1, contract: { ...HOST } },
      { machine: "pc", since: Date.UTC(2026, 9, 31, 11, 40), proto: 1, contract: { ...HOST } },
    ],
    sessions: [
      { callsign: "profiles@laptop", state: "waiting", model: "sonnet", effort: "high", slot: { name: "main", wait: null }, account: "infirex", profile: null, remote: { url: "https://claude.ai/code/session_01Pf" } },
      { callsign: "api@pc", state: "failed", model: "sonnet", effort: "medium", slot: { name: "main", wait: null }, account: "y0902", failed: { core: "второй сбой до initialize" } },
      { callsign: "site@laptop", state: "busy", model: "opus", effort: "high", slot: { name: "main", wait: null }, account: "infirex", profile: { id: "team/profiles/ops", state: "ok" }, remote: { url: "https://claude.ai/code/session_01Pf" } },
      { callsign: "poe-bot@pc", state: "busy", model: "sonnet", effort: "medium", slot: { name: "main", wait: null }, account: "y0902" },
      { callsign: "wiki@laptop", state: "idle", model: "haiku", effort: "low", slot: { name: "bot", wait: null }, account: "work3", profile: { id: "team/profiles/writer", state: "ok" } },
      { callsign: "docs@pc", state: "stopped", model: "sonnet", slot: { name: "main", wait: null }, account: "y0902" },
    ],
    clients: ["phone", "panel-desk"],
    workers: [worker("push"), worker("points"), worker("ledger"), worker("github")],
    ...over,
  };
}

/** relay с ответами владельцев по умолчанию: лента, история, вопросы. */
export function fleetRelay(roster = fleetRoster()): FakeRelay {
  const relay = new FakeRelay(roster);
  relay.handlers["session.watch"] = () => ({ ok: true });
  relay.handlers["session.unwatch"] = () => ({ ok: true });
  relay.handlers["session.history"] = () => ({ ok: true, result: { messages: [], more: false } });
  relay.handlers["question.list"] = () => ({ ok: true, result: [] });
  relay.handlers["machine.accounts"] = () => ({ ok: true, result: { accounts: {} } });
  return relay;
}

/** Поднять пульт на стенде. */
export async function pult(o: { relay?: FakeRelay; roster?: Roster; url?: string; store?: ReturnType<typeof memoryStore> } = {}) {
  const relay = o.relay ?? fleetRelay(o.roster);
  const store = o.store ?? memoryStore({ key: KEY });
  const t = await stand(pultParts(fakeBrowser("granted")), { relay, store, url: o.url, options: PULT });
  await flush();
  /** напечатать в поле и дать отработать */
  const type = async (el: Element | null, text: string, ev = "input") => {
    if (!el) throw new Error("стенд: нет поля");
    (el as HTMLInputElement).value = text;
    el.dispatchEvent(new Event(ev));
    await flush();
  };
  /** кнопка по тексту внутри элемента */
  const btn = (scope: Element | null, text: string | RegExp) =>
    [...(scope ?? t.root).querySelectorAll<HTMLButtonElement>("button")].find((b) => (typeof text === "string" ? b.textContent?.trim() === text : text.test(b.textContent ?? ""))) ?? null;
  /** открыть экран по адресу */
  const go = async (hash: string) => {
    location.hash = hash;
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    await flush(10);
  };
  return { ...t, type, btn, go, relay, store };
}

export { flush };
