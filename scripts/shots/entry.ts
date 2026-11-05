// Настоящий код страниц на подделке relay: большой и малый флот — для снимков глазами. ?app=pult|phone&kind=small|big
import { memoryStore, startApp } from "../../web/packages/core/contract.ts";
import { FakeRelay } from "../../web/packages/core/stand/relay.ts";
import { folderOf } from "../../web/packages/ui/contract.ts";
import { PULT, pultParts } from "../../web/pult/stand/parts.ts";
import { phoneParts } from "../../web/phone/stand/parts.ts";
import { galleryPart } from "../../web/packages/chat/stand/gallery/part.ts";
import { fakeBrowser } from "../../web/packages/alerts/stand/fakes.ts";
import { answerRequests } from "./answers.ts";
import { bigFleet, type Fleet, type S, SMALL } from "./fleets.ts";

declare const __HOST__: Record<string, number>;
const q = new URLSearchParams(location.search);
const app = q.get("app") ?? "pult";
const kind = q.get("kind") ?? "small";
const ME = "you@mail.ru";
const HOUR = 3600000;
const PHONE_SECTIONS = ["inbox", "board", "accounts", "machines", "profiles", "incidents", "settings"];

/** Строка roster о сессии флота. */
const sessionOf = (s: S) => ({
  callsign: s.cs,
  dir: s.dir,
  state: s.state,
  model: s.model,
  effort: s.effort,
  by: s.who === "me" ? `pult~${ME}` : `laptop~${s.who}@mail.ru`,
  parent: s.parent,
  slot: { name: "main" },
  account: "y0902",
  mode: "bypassPermissions",
  ...(s.prof ? { profile: { id: `team/profiles/${s.prof}`, state: "ok" } } : {}),
  ...(s.fail ? { failed: { start: s.fail } } : {}),
  ...(s.inc ? { incident: { type: s.inc, key: "switchboard#main", state: "open" } } : {}),
  ...(s.cs === "refactor@win" ? { r2: { at: Date.now() - 60000 } } : {}),
});

const rosterOf = (F: Fleet) => ({
  type: "roster" as const,
  machines: F.ms.map((machine) => ({ machine, since: Date.now() - HOUR, proto: 1, contract: __HOST__ })),
  sessions: F.ss.map(sessionOf),
  clients: [`pult~${ME}`, `phone~${ME}`, "laptop~anna@mail.ru", "laptop~oleg@mail.ru"],
});

/** Проекты — запись области флота, как после заполнения при выкладке: папка каждой сессии стала проектом. */
function projectsOf(F: Fleet, top: string[]) {
  const byFolder = new Map<string, string[]>();
  for (const s of [...F.ss].sort((a, b) => a.cs.localeCompare(b.cs))) {
    const folder = folderOf(s.dir);
    if (folder !== "~") byFolder.set(folder, [...(byFolder.get(folder) ?? []), s.cs]);
  }
  const rank = (name: string) => (top.includes(name) ? top.indexOf(name) : Infinity);
  return [...byFolder].sort((a, b) => (rank(a[0]) === rank(b[0]) ? a[0].localeCompare(b[0]) : rank(a[0]) - rank(b[0]))).map(([id, sessions]) => ({ id, name: id, sessions }));
}

const F = kind === "big" ? bigFleet() : SMALL;
const roster = rosterOf(F);
const relay = new FakeRelay(roster as never);
(window as unknown as { __relay: FakeRelay }).__relay = relay;

relay.scoped.global = { "fleet.projects": projectsOf(F, kind === "small" ? ["pfarm", "switchboard"] : ["switchboard", "pfarm"]) };
if (kind === "small") {
  relay.scoped.global["fleet.labels"] = { machines: { win: "Домашний ПК", wsl: "Ubuntu дома" }, sessions: { "refactor@win": "Переделка списка" } };
  relay.values["web-board.filters"] = [{ id: "f1", name: "pfarm", projects: ["pfarm"] }];
} else {
  relay.values["web-board.filters"] = [
    { id: "f1", name: "GPU", machines: ["gpu-01", "gpu-02"] },
    { id: "f2", name: "Ждут и сбои", states: ["waiting", "failed"] },
    { id: "f3", name: "Дежурство", profiles: ["ops", "sre"], who: ["mine"] },
  ];
}
answerRequests(relay, F, roster, app, ME);

/** gate отдаёт машины через стенд; полный список пропусков — обработчик. */
const fetchThroughGate = (async (url: string | URL | Request, init?: RequestInit) => {
  const f = JSON.parse(String(init?.body));
  if (String(url) === FakeRelay.WORKERS.gate && f.type === "keys.list" && f.role === undefined) return Response.json({ type: "reply", id: f.id, ok: true, result: relay.handlers["keys.list"]!(f)!.result });
  return relay.fetch(url, init);
}) as typeof fetch;

const browser = fakeBrowser("granted");
const run = startApp({
  root: document.getElementById("app")!,
  workers: FakeRelay.WORKERS,
  fetch: fetchThroughGate,
  parts: [...(app === "pult" ? pultParts(browser) : phoneParts(browser)), galleryPart],
  store: memoryStore({ key: `client.${app}.k3f1.Qa7sig` }),
  WebSocket: relay.WebSocket,
  platform: { ios: false, standalone: false },
  pauseMs: 50,
  ...(app === "pult" ? PULT : { sections: PHONE_SECTIONS }),
});
// непрочитанное приходит кадрами
void run.ready.then(() => {
  setTimeout(() => {
    for (const s of F.ss) if (s.unread) relay.push({ type: "message", from: s.cs, to: `${app}~${ME}`, text: s.unread });
  }, 50);
});
Object.assign(window, { relay, run });
