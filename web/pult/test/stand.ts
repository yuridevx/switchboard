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
      { callsign: "site@laptop", dir: "~/Projects/switchboard", by: "panel-desk~owner@example.com", state: "busy", model: "opus", effort: "high", slot: { name: "main", wait: null }, account: "infirex", profile: [{ id: "team/profiles/ops", state: "ok" }], remote: { url: "https://claude.ai/code/session_01Pf" } },
      { callsign: "poe-bot@pc", dir: "~/Projects/poe", by: "panel-desk~owner@example.com", state: "busy", model: "sonnet", effort: "medium", slot: { name: "main", wait: null }, account: "y0902" },
      { callsign: "wiki@laptop", dir: "~/Projects/switchboard", by: "panel-desk~owner@example.com", state: "idle", model: "haiku", effort: "low", slot: { name: "bot", wait: null }, account: "work3", profile: [{ id: "team/profiles/writer", state: "ok" }] },
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

/** Часть ответа machine.accounts о слотах: тест задаёт её отдельно от аккаунтов. Не задана — на машине слотов нет. */
export const SLOTS = "слоты в ответе machine.accounts";
type Answer = { ok: boolean; result?: unknown; error?: string } | undefined;

/** Обработчики стенда: machine.accounts собирается из аккаунтов и слотов; отказ или молчание любой части — ответ целиком. */
function composeAccounts(relay: FakeRelay) {
  let accounts: (f: Parameters<FakeRelay["handlers"][string]>[0]) => Answer = () => ({ ok: true, result: { accounts: {} } });
  Object.defineProperty(relay.handlers, "machine.accounts", {
    enumerable: true,
    set: (h) => void (accounts = h),
    get: () => (x: Parameters<FakeRelay["handlers"][string]>[0]) => {
      const a = accounts(x);
      const hs = relay.handlers[SLOTS];
      if (!a?.ok) return a;
      if (!hs) return { ok: true, result: { slots: {}, ...(a.result as object) } };
      const sl = hs(x) as Answer;
      if (!sl?.ok) return sl;
      return { ok: true, result: { ...(a.result as object), slots: (sl.result as { slots: unknown }).slots } };
    },
  });
}

/** relay с ответами владельцев по умолчанию: лента, история, вопросы. */
export function fleetRelay(roster = fleetRoster()): FakeRelay {
  const relay = new FakeRelay(roster);
  composeAccounts(relay);
  relay.handlers["session.watch"] = () => ({ ok: true });
  relay.handlers["session.unwatch"] = () => ({ ok: true });
  relay.handlers["session.history"] = () => ({ ok: true, result: { messages: [], more: false } });
  relay.handlers["question.list"] = () => ({ ok: true, result: [] });
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

/** Разговор site@laptop на голове: три обмена и вызовы модели к ответам. */
export const TALK = [
  { type: "user", uuid: "u1", message: { role: "user", content: "обнови зависимости и прогони тесты" } },
  { type: "assistant", uuid: "a1", message: { id: "msg_a1", role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "Обновил 14 пакетов, тесты зелёные." }] } },
  { type: "user", uuid: "u2", message: { role: "user", content: "перенеси журнал в ClickHouse" } },
  { type: "assistant", uuid: "a2", message: { id: "msg_a2", role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "Журнал перенесён." }] } },
];
export const CALLS = [
  { uuid: "a1", at: "2026-10-31T09:58:00.000Z", model: "claude-opus-5-5", tok_in: 18000, tok_out: 420, system: "You are Claude Code." },
  { uuid: "a2", at: "2026-10-31T14:48:00.000Z", model: "claude-opus-5-5", tok_in: 3100000, tok_out: 88000, system: "You are Claude Code." },
];

/** Строка каталога site@laptop: заголовок, модель и токены. */
export const SITE_ROW = { sid: SID, callsign: "site@laptop", title: "Перенеси журнал в ClickHouse", model: "claude-opus-5-5", tok_in: 3118000, tok_out: 88420, dir: "~/Projects/site", owner: "laptop", head: { id: 41, at: Date.UTC(2026, 9, 31, 14, 49) }, points: 3, branches: 1 };

/** site@laptop в архиве с линией точек; ответы каталога, points.history и host-points. */
export function pointsRelay(over: (r: Roster) => void = () => {}) {
  const r = fleetRoster();
  Object.assign(r.sessions[2], { archive: {} });
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
              { id: 41, at: at(14, 49), machine: "laptop", why: "rule", base: 40, dir: "~/Projects/site", msgs: 4, git: { state: "dirty", files: 2, branch: "main" }, line: true, until: null },
              { id: 38, at: at(10, 0), machine: "laptop", why: "rule", base: 37, dir: "~/Projects/site", msgs: 2, git: { state: "clean", branch: "main" }, line: true, until: 1824993120000 },
              { id: 33, at: at(8, 15), machine: "laptop", why: "rule", base: 31, dir: "~/Projects/site", line: false, until: 1824993120000 },
            ],
          },
        }
      : {
          ok: true,
          result: { search: true, sessions: [SITE_ROW], store: { bytes: 432013312, blocks: 2410 }, sweep: null },
        };
  // точка 38 — после первого обмена, голова 41 — весь разговор
  relay.handlers["points.history"] = (f) => {
    const n = f.point === 38 ? 2 : TALK.length;
    return { ok: true, result: { point: f.point ?? 41, messages: TALK.slice(0, n), calls: CALLS.slice(0, n / 2), more: false } };
  };
  relay.handlers[SLOTS] = () => ({ ok: true, result: { slots: { main: { account: "y0902", order: ["y0902"], wait: null, sessions: [] } } } });
  return relay;
}

