// Страница стенда: настоящий код приложения на подделке relay. ?app=pult|phone&kind=small|big
import type { SessionRecord } from "@switchboard/relay";
import { memoryStore, startApp } from "@switchboard/web-core";
import { fakeBrowser } from "../../web/packages/alerts/stand/fakes.ts";
import { galleryPart } from "../../web/packages/chat/stand/gallery/part.ts";
import { FakeRelay, KEY } from "../../web/packages/core/stand/relay.ts";
import { phoneParts } from "../../web/phone/stand/parts.ts";
import { PULT, pultParts } from "../../web/pult/stand/parts.ts";
import { answerRequests } from "./answers.ts";
import { bigFleet, SMALL, type S } from "./fleets.ts";

const ME = "you@mail.ru";
const query = new URLSearchParams(location.search);
const app = query.get("app") ?? "pult";
const big = query.get("kind") === "big";
const F = big ? bigFleet() : SMALL;

const project = (s: S) => (s.dir === "~" ? "~" : s.dir.slice(s.dir.lastIndexOf("/") + 1));

const session = (s: S): SessionRecord => ({
  callsign: s.cs,
  dir: s.dir,
  state: s.state,
  model: s.model,
  effort: s.effort,
  by: `${app}~${s.who === "me" ? ME : `${s.who}@mail.ru`}`,
  parent: s.parent,
  slot: { name: "main", wait: null },
  account: "dev@mail.ru",
  mode: "bypassPermissions",
  ...(s.cs === "refactor@win" ? { r2: {} } : {}),
  ...(s.prof ? { profile: { id: `team/profiles/${s.prof}`, state: "ok" } } : {}),
  ...(s.fail ? { failed: { start: s.fail } } : {}),
  ...(s.inc ? { incident: { type: s.inc, key: "switchboard#main" } } : {}),
});

const roster = {
  type: "roster" as const,
  machines: [] as Array<{ machine: string; since: number; proto: number; contract: Record<string, number> }>,
  sessions: F.ss.map(session),
  clients: [`pult~${ME}`, `phone~${ME}`],
};
const relay = new FakeRelay(roster);
relay.you = `${app}~${ME}`;
answerRequests(relay, F, roster, app, ME);
const contract = Object.fromEntries([...Object.keys(relay.handlers), "incident", "points.raise", "points.save", "session.profile", "session.remove", "session.slot", "session.start", "session.stop"].map((type) => [type, 1]));
roster.machines.push(...F.ms.map((machine) => ({ machine, since: 1, proto: 1, contract })));

const names = [...new Set(F.ss.map(project))].filter((id) => id !== "~").sort();
const order = big ? ["switchboard", "pfarm", ...names.filter((id) => id !== "switchboard" && id !== "pfarm")] : names;
relay.scoped.global = {
  "fleet.projects": order.map((id) => ({ id, name: id, sessions: F.ss.filter((s) => project(s) === id).map((s) => s.cs).sort() })),
  "fleet.labels": big ? {} : { machines: { win: "Домашний ПК", wsl: "Ubuntu дома" }, sessions: { "refactor@win": "Переделка списка" } },
};
relay.values["web-board.filters"] = big
  ? [
      { id: "f1", name: "GPU", machines: ["gpu-01", "gpu-02"] },
      { id: "f2", name: "Ждут и сбои", states: ["waiting", "failed"] },
      { id: "f3", name: "Дежурство", who: ["mine"], profiles: ["ops", "sre"] },
    ]
  : [{ id: "f1", name: "pfarm", projects: ["pfarm"] }];

Object.assign(window, { relay, __relay: relay });

/** Пропуска экрана настроек — у обработчика стенда; список машин (role: host) — у подделки. */
const askGate: typeof fetch = async (url, init) => {
  const f = JSON.parse(String(init?.body));
  return f.type === "keys.list" && !f.role ? Response.json({ type: "reply", id: f.id, ...relay.handlers["keys.list"](f) }) : relay.fetch(url, init);
};

startApp({
  root: document.getElementById("app")!,
  workers: FakeRelay.WORKERS,
  fetch: askGate,
  WebSocket: relay.WebSocket,
  store: memoryStore({ key: KEY }),
  application: app,
  ...(app === "pult" ? PULT : {}),
  parts: [...(app === "pult" ? pultParts(fakeBrowser()) : phoneParts(fakeBrowser())), galleryPart],
});

/** Сообщения сессий — когда открыты соединения всех машин: кадр идёт соединением своей машины. */
const unread = () => {
  if (relay.open.length < F.ms.length) return void setTimeout(unread, 20);
  for (const s of F.ss) if (s.unread) relay.push({ type: "message", from: s.cs, to: relay.you, text: s.unread });
};
unread();
