// Стенд пульта: страница happy-dom, поддельный relay с флотом home из дизайна и ответами владельцев.
// Контракт машины — provides всех модулей Host монорепо, как Host шлёт его в hello.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRepo } from "@switchboard/manifest-gate";
import { memoryStore, type Roster } from "@switchboard/web-core";
import { PULT, pultParts } from "../stand/parts.ts";
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
      { callsign: "profiles@laptop", dir: "~/Projects/switchboard", by: "panel-desk~owner@example.com", state: "waiting", model: "sonnet", effort: "high", slot: { name: "main", wait: null }, account: "infirex", profile: null, remote: { url: "https://claude.ai/code/session_01Pf" } },
      { callsign: "api@pc", dir: "~/Projects/switchboard", by: "panel-desk~owner@example.com", state: "failed", model: "sonnet", effort: "medium", slot: { name: "main", wait: null }, account: "y0902", failed: { core: "второй сбой до initialize" } },
      { callsign: "site@laptop", dir: "~/Projects/switchboard", by: "panel-desk~owner@example.com", state: "busy", model: "opus", effort: "high", slot: { name: "main", wait: null }, account: "infirex", profile: { id: "team/profiles/ops", state: "ok" }, remote: { url: "https://claude.ai/code/session_01Pf" } },
      { callsign: "poe-bot@pc", dir: "~/Projects/poe", by: "panel-desk~owner@example.com", state: "busy", model: "sonnet", effort: "medium", slot: { name: "main", wait: null }, account: "y0902" },
      { callsign: "wiki@laptop", dir: "~/Projects/switchboard", by: "panel-desk~owner@example.com", state: "idle", model: "haiku", effort: "low", slot: { name: "bot", wait: null }, account: "work3", profile: { id: "team/profiles/writer", state: "ok" } },
      { callsign: "docs@pc", dir: "~/Projects/switchboard", by: "panel-desk~owner@example.com", state: "stopped", model: "sonnet", slot: { name: "main", wait: null }, account: "y0902" },
    ],
    clients: ["phone~owner@example.com", "panel-desk~owner@example.com"],
    ...over,
  };
}

/** Флот home, в который вошла новая сессия: состав сменился. */
export function joinedRoster(): Roster {
  const r = fleetRoster();
  return { ...r, sessions: [...r.sessions, { callsign: "new@laptop", dir: "~", by: "panel-desk~owner@example.com", state: "idle" }] };
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
export async function pult(o: { relay?: FakeRelay; roster?: Roster; url?: string; store?: ReturnType<typeof memoryStore>; workers?: Record<string, string> } = {}) {
  const relay = o.relay ?? fleetRelay(o.roster);
  const store = o.store ?? memoryStore({ key: KEY });
  // эталоны пульта — про «Работу», карточку и флот: стенд открывается на «Работе», домашний раздел проверяют своим адресом
  const t = await stand(pultParts(fakeBrowser("granted")), { relay, store, url: o.url ?? "/#sessions", options: { ...PULT, ...(o.workers ? { workers: o.workers } : {}) } });
  await flush();
  /** напечатать в поле и дать отработать */
  const type = async (el: Element | null, text: string, ev = "input") => {
    if (!el) throw new Error("стенд: нет поля");
    (el as HTMLInputElement).value = text;
    el.dispatchEvent(new Event(ev, { bubbles: true }));
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

/** sid сессии site@laptop в реестре точек стенда. */
export const SID = "42bc5ad4";

/** site@laptop в R2 с линией точек; ответы реестра и host-points. */
export function pointsRelay(over: (r: Roster) => void = () => {}) {
  const r = fleetRoster();
  Object.assign(r.sessions[2], { r2: {} });
  over(r);
  const relay = fleetRelay(r);
  const at = (hh: number, mm: number) => Date.UTC(2026, 9, 31, hh, mm);
  relay.handlers["points.list"] = (f) =>
    f.sid
      ? {
          ok: true,
          result: {
            owner: "laptop",
            head: 41,
            points: [
              { id: 41, at: at(14, 49), machine: "laptop", why: "rule", base: 40, dir: "~/Projects/site", msgs: 212, git: { state: "dirty", files: 2, branch: "main" }, line: true, until: null },
              { id: 38, at: at(10, 0), machine: "laptop", why: "rule", base: 37, dir: "~/Projects/site", msgs: 194, git: { state: "clean", branch: "main" }, line: true, until: 1824993120000 },
              { id: 33, at: at(8, 15), machine: "laptop", why: "rule", base: 31, dir: "~/Projects/site", line: false, until: 1824993120000 },
            ],
          },
        }
      : {
          ok: true,
          result: {
            sessions: [{ sid: SID, callsign: "site@laptop", dir: "~/Projects/site", owner: "laptop", head: { id: 41, at: at(14, 49) }, points: 41, branches: 1 }],
            r2: { bytes: 432013312, blocks: 2410 },
            sweep: null,
          },
        };
  relay.handlers["points.get"] = (f) => ({ ok: true, result: { owner: "laptop", points: (f.ids as number[]).map((id) => ({ id, last: [["обнови зависимости и прогони тесты", "Обновил 14 пакетов"]] })) } });
  relay.handlers["machine.slots"] = () => ({ ok: true, result: { slots: { main: { account: "y0902", order: ["y0902"], wait: null, sessions: [] } } } });
  return relay;
}

