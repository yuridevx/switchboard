// Обрыв соединения с одной машиной при живом Host: Host снимает зрителя (roster без клиента), лента должна подписаться заново.
// Источник: устав — соединение с объектом relay машины оборвалось, клиенты переподключаются; контракт ядра: on.link open —
// hello принят, открытые экраны заново шлют свои подписки. Факт: host/modules/watch снимает зрителя, которого нет в roster.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createAlerts, manifest as alertsM } from "@switchboard/web-alerts";
import { createAsk, manifest as askM } from "@switchboard/web-ask";
import { createBoard, manifest as boardM } from "@switchboard/web-board";
import { createCard, manifest as cardM } from "@switchboard/web-card";
import { createChat, manifest as chatM } from "../contract.ts";
import { FakeRelay, flush, homeRoster, stand } from "../../core/stand/app.ts";

const parts = () => [
  { manifest: boardM, module: createBoard },
  { manifest: cardM, module: createCard },
  { manifest: chatM, module: createChat },
  { manifest: askM, module: createAsk },
  { manifest: alertsM, module: createAlerts({}) },
];

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

it("6595 · оборвалось соединение только с машиной открытой сессии: session.watch и session.history заново; лента идёт дальше", async () => {
  const relay = new FakeRelay(homeRoster());
  relay.handlers["session.watch"] = () => ({ ok: true });
  relay.handlers["session.unwatch"] = () => ({ ok: true });
  relay.handlers["session.history"] = () => ({ ok: true, result: { messages: [], more: false } });
  relay.handlers["question.list"] = () => ({ ok: true, result: [] });
  await stand(parts(), { relay, url: `/#chat?callsign=${encodeURIComponent("site@laptop")}` });
  await flush();
  expect(relay.sent("session.watch")).toHaveLength(1);
  expect(relay.open.length).toBeGreaterThan(1);
  const own = relay.open.find((s) => s.url.endsWith("/m/laptop"))!;
  own.serverClose(1006, "");
  await new Promise((r) => setTimeout(r, 30));
  await flush(10);
  expect(relay.open.some((s) => s.url.endsWith("/m/laptop"))).toBe(true);
  expect(relay.sent("session.watch").length).toBeGreaterThanOrEqual(2);
  expect(relay.got.filter((f) => f.type === "session.watch" || f.type === "session.history").slice(-2).map((f) => f.type)).toEqual(["session.watch", "session.history"]);
});

it("7217 · вернулась другая машина: подписка открытой сессии и настройки не читаются заново, вопросы — только у неё", async () => {
  // источник: гейт архитектора — лишняя коммуникация; подписки пропали только у вернувшейся машины, настройки живут у Worker'а
  const relay = new FakeRelay(homeRoster());
  relay.handlers["session.watch"] = () => ({ ok: true });
  relay.handlers["session.unwatch"] = () => ({ ok: true });
  relay.handlers["session.history"] = () => ({ ok: true, result: { messages: [], more: false } });
  relay.handlers["question.list"] = () => ({ ok: true, result: [] });
  await stand(parts(), { relay, url: `/#chat?callsign=${encodeURIComponent("site@laptop")}` });
  await flush();
  const other = relay.open.find((s) => !s.url.endsWith("/m/laptop"))!;
  const was = { watch: relay.sent("session.watch").length, prefs: relay.sent("prefs.get").length };
  other.serverClose(1006, "");
  await new Promise((r) => setTimeout(r, 30));
  await flush(10);
  expect(relay.open.some((s) => s.url === other.url)).toBe(true);
  expect(relay.sent("session.watch").length - was.watch).toBe(0);
  expect(relay.sent("prefs.get").length - was.prefs).toBe(0);
});

it("7240 · новый hello принёс новый since: подписка в пути, второго обмена нет", async () => {
  // источник: гейт архитектора — лишняя коммуникация; подписка, посланная после возврата связи, уже идёт к машине
  const relay = new FakeRelay(homeRoster());
  relay.handlers["session.watch"] = () => ({ ok: true });
  relay.handlers["session.unwatch"] = () => ({ ok: true });
  relay.handlers["session.history"] = () => ({ ok: true, result: { messages: [], more: false } });
  relay.handlers["question.list"] = () => ({ ok: true, result: [] });
  await stand(parts(), { relay, url: `/#chat?callsign=${encodeURIComponent("site@laptop")}` });
  await flush();
  const was = relay.sent("session.watch").length;
  // Host этой машины поднялся заново, пока связь с ней лежала: новый since приходит вместе с новым hello
  const back = homeRoster();
  back.machines.find((m) => m.machine === "laptop")!.since = 777;
  relay.roster = back;
  // ответа на подписку пока нет: она в пути, когда приходит roster
  relay.handlers["session.watch"] = () => undefined;
  relay.open.find((s) => s.url.endsWith("/m/laptop"))!.serverClose(1006, "");
  await new Promise((r) => setTimeout(r, 30));
  await flush(10);
  expect(relay.sent("session.watch").length - was).toBe(1);
});

it("7241 · прежний Host отказал подписке, новый пришёл, пока она шла: подписка к новому", async () => {
  // источник: устав — Host перезапустился, клиенты подключаются заново; лента не должна молча остаться без подписки
  const relay = new FakeRelay(homeRoster());
  relay.handlers["session.watch"] = () => ({ ok: true });
  relay.handlers["session.unwatch"] = () => ({ ok: true });
  relay.handlers["session.history"] = () => ({ ok: true, result: { messages: [], more: false } });
  relay.handlers["question.list"] = () => ({ ok: true, result: [] });
  await stand(parts(), { relay, url: `/#chat?callsign=${encodeURIComponent("site@laptop")}` });
  await flush();
  const was = relay.sent("session.watch").length;
  let held: string | undefined;
  relay.handlers["session.watch"] = (f) => {
    held = f.id as string;
    return undefined;
  };
  relay.open.find((s) => s.url.endsWith("/m/laptop"))!.serverClose(1006, "");
  await new Promise((r) => setTimeout(r, 30));
  await flush(10);
  const back = homeRoster();
  back.machines.find((m) => m.machine === "laptop")!.since = 777;
  relay.setRoster(back);
  await flush(10);
  relay.handlers["session.watch"] = () => ({ ok: true });
  relay.reply(held!, { ok: false, error: "offline" });
  await flush(10);
  expect(relay.sent("session.watch").length - was).toBe(2);
});
