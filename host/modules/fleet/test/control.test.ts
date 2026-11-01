// Эталоны управления сессиями из сессии: инструменты fleet open, history, update, remove, list и итог хода родителю.
// Стенд Host: поддельные SDK, relay, держатели и часы; manage — настоящий, slots и profiles — поддельные модули стенда.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stand } from "@switchboard/host";
import type { Frame, Manifest } from "@switchboard/host";
import manifest from "../module.json" with { type: "json" };
import { make, wrap } from "../src/fleet.ts";
import { manage } from "../../manage/src/manage.ts";

const { FakeHolders, FakeRelay, module, msg, standHost, turn, until } = stand;
type Stand = stand.Stand;
const manageManifest = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "manage", "module.json"), "utf8")) as Manifest;

const stands: Stand[] = [];
const keepers: stand.FakeHolders[] = [];
afterEach(async () => {
  for (const s of stands.splice(0)) await s.close();
  for (const k of keepers.splice(0)) await k.close();
});

/** Host с fleet и настоящим manage; dir — папка для session.open; home и holders — для перезапуска Host; holdRoster — relay ещё не прислал roster. */
async function bench(machine = "win", o: { home?: string; holders?: stand.FakeHolders; holdRoster?: boolean } = {}) {
  const f = make();
  const dir = mkdtempSync(join(tmpdir(), "switchboard-fleet-"));
  const slots = module("host-slots", { requests: { "session.slot": () => ({ restart: false }) } });
  const profiles = module("host-profiles", { requests: { "session.profile": () => ({ restart: false }) } });
  const relay = new FakeRelay();
  relay.holdRoster = !!o.holdRoster;
  const st = await standHost({
    machine,
    home: o.home,
    holders: o.holders,
    relayStand: relay,
    modules: [slots, profiles, { manifest: manageManifest, module: manage({ home: dir }) }, { manifest: manifest as Manifest, module: f.module }],
  });
  stands.push(st);
  const call = async (me: string, name: string, args: Record<string, unknown>) => {
    const t = f.tools(me).find((x) => x.name === name)!;
    return (await t.handler(args as never, {})) as { content: Array<{ text: string }>; isError?: boolean };
  };
  /** поле roster сессии в последнем session.state */
  const field = (cs: string, k: string) => st.states(cs).at(-1)?.[k];
  return { st, call, dir, field };
}

/** roster от relay с родителями сессий — fleet берёт родителя отсюда. */
function roster(st: Stand, sessions: Array<{ callsign: string; parent?: string }>) {
  st.relay.deliver({ type: "roster", machines: [], sessions: sessions.map((s) => ({ state: "idle", ...s })), clients: ["phone~owner@example.com"], workers: [] } as Frame);
}

describe("эталоны: сессия ведёт другие сессии", () => {
  it("296 · lead@win: open дочери на wsl — session.open на wsl от lead@win, затем задача message от lead@win; ответ — callsign", async () => {
    const { st, call } = await bench();
    await st.open("lead@win");
    const pending = call("lead@win", "open", { name: "fix-auth", machine: "wsl", dir: "~/app", text: "Почини вход: токен истекает через минуту" });
    const o = await until(() => st.relay.frames("session.open")[0]);
    expect(o).toMatchObject({ type: "session.open", v: 1, machine: "wsl", name: "fix-auth", dir: "~/app", from: "lead@win" });
    st.relay.deliver({ type: "reply", id: o.id as string, ok: true, result: { callsign: "fix-auth@wsl", session_id: "s1" } } as Frame);
    const m = await until(() => st.relay.frames("message")[0]);
    expect(m).toMatchObject({ type: "message", v: 1, to: "fix-auth@wsl", text: "Почини вход: токен истекает через минуту", from: "lead@win" });
    st.relay.deliver({ type: "reply", id: m.id as string, ok: true } as Frame);
    expect((await pending).content[0].text).toBe("открыта: fix-auth@wsl; задача во вводе, итог хода придёт сам");
  });

  it("297 · lead@win: open дочери на своей машине — parent lead@win, не @win; тот же отправитель в журнале флота", async () => {
    const { st, call, dir, field } = await bench();
    await st.open("lead@win");
    const r = await call("lead@win", "open", { name: "docs", dir, text: "Обнови README" });
    expect(r.content[0].text).toBe("открыта: docs@win; задача во вводе, итог хода придёт сам");
    await until(() => field("docs@win", "parent") === "lead@win");
    expect(st.relay.frames("ledger.add").find((f) => f.ev === "session.opened")).toMatchObject({ by: "lead@win", callsign: "docs@win" });
    await until(() => st.proc("docs@win").inputs.length === 1);
    expect(st.proc("docs@win").inputs[0].message.content).toBe(wrap("lead@win", "Обнови README"));
  });

  it("298 · remove другой сессии — сессия убрана из списка и roster; в журнале флота session.removed от lead", async () => {
    const { st, call, dir } = await bench();
    await st.open("lead@win");
    await call("lead@win", "open", { name: "docs", dir, text: "x" });
    const r = await call("lead@win", "remove", { callsign: "docs@win" });
    expect(r.content[0].text).toBe("закрыта: docs@win");
    expect(st.kernel.sessions.has("docs@win")).toBe(false);
    expect(st.relay.sent.filter((f) => f.type === "session.state" && f.callsign === "docs@win").at(-1)).toMatchObject({ state: null });
    expect(st.relay.frames("ledger.add").find((f) => f.ev === "session.removed")).toMatchObject({ by: "lead@win", callsign: "docs@win" });
  });

  it("299 · remove себя посреди хода — ход не прерван; после его конца сессия убрана", async () => {
    const { st, call } = await bench();
    const s = await st.open("lead@win");
    const p = st.proc("lead@win");
    p.send(msg.state("running"));
    await until(() => s.state === "busy");
    const r = await call("lead@win", "remove", {});
    expect(r.content[0].text).toBe("закроюсь после этого хода");
    expect(p.interrupts).toBe(0);
    expect(st.kernel.sessions.has("lead@win")).toBe(true);
    p.send(msg.result({ result: "готово" }));
    p.send(msg.state("idle"));
    await until(() => !st.kernel.sessions.has("lead@win"));
    expect(p.interrupts).toBe(0);
    expect(st.relay.frames("ledger.add").find((f) => f.ev === "session.removed")).toMatchObject({ by: "lead@win", callsign: "lead@win" });
  });

  it("300 · update model у живой дочери — setModel сразу; в roster новое значение model", async () => {
    const { st, call, dir, field } = await bench();
    await st.open("lead@win");
    await call("lead@win", "open", { name: "docs", dir, text: "x" });
    const r = await call("lead@win", "update", { callsign: "docs@win", model: "sonnet" });
    expect(r.content[0].text).toBe("сразу: model");
    expect(st.query("docs@win").calls).toContainEqual({ name: "setModel", args: ["sonnet"] });
    await until(() => field("docs@win", "model") === "sonnet");
  });

  it("301 · history сессии на другой машине — запрос session.history через relay; последние записи текстом", async () => {
    const { st, call } = await bench();
    await st.open("lead@win");
    const pending = call("lead@win", "history", { callsign: "fix-auth@wsl", limit: 3 });
    const h = await until(() => st.relay.frames("session.history")[0]);
    expect(h).toMatchObject({ type: "session.history", v: 1, callsign: "fix-auth@wsl", limit: 3, before: null, from: "lead@win" });
    const messages = [
      { type: "user", uuid: "u1", message: { role: "user", content: "Добавь тест на logout" } },
      { type: "assistant", uuid: "u2", message: { role: "assistant", content: [{ type: "text", text: "Добавил test/logout.test.ts" }, { type: "tool_use", id: "t1", name: "Bash", input: {} }] } },
      { type: "system", uuid: "u3", subtype: "init" },
    ];
    st.relay.deliver({ type: "reply", id: h.id as string, ok: true, result: { messages, more: true } } as Frame);
    expect((await pending).content[0].text).toBe("user: Добавь тест на logout\nassistant: Добавил test/logout.test.ts\ntool: Bash");
  });

  it("302 · list — сессии флота с родителем, моделью и состоянием; клиенты", async () => {
    const { st, call } = await bench();
    roster(st, [{ callsign: "lead@win" }, { callsign: "fix-auth@wsl", parent: "lead@win" }]);
    await new Promise((r) => setTimeout(r, 10));
    const r = JSON.parse((await call("lead@win", "list", {})).content[0].text);
    expect(r.sessions).toEqual([
      { callsign: "lead@win", state: "idle", parent: null, model: null },
      { callsign: "fix-auth@wsl", state: "idle", parent: "lead@win", model: null },
    ]);
    expect(r.clients).toEqual(["phone~owner@example.com"]);
  });

  it("311 · дочь кончила ход, последний ввод — от родителя-сессии: родителю message от дочери с текстом result; дочь send не звала; родитель — от manage этой машины, roster не нужен; отправитель ввода родителя прежний — его вопрос уходит человеку", async () => {
    const { st, call, dir } = await bench();
    await st.open("lead@win");
    st.session("host-fleet", "lead@win")!.input("Наведи порядок в документации", { from: "phone~owner@example.com" });
    await call("lead@win", "open", { name: "docs", dir, text: "Обнови README" });
    const kid = st.proc("docs@win");
    await until(() => kid.inputs.length === 1);
    turn(kid, "работаю", { result: "README обновлён: раздел установки" });
    const lead = st.proc("lead@win");
    await until(() => lead.inputs.length === 2);
    expect(lead.inputs[1]).toMatchObject({ priority: "next", message: { content: wrap("docs@win", "README обновлён: раздел установки") } });
    expect(st.session("host-fleet", "lead@win")!.info.from).toBe("phone~owner@example.com");
  });

  it("313 · Host дочери перезапустился посреди хода: ход дошёл у держателя, итог — родителю сразу после подключения, без roster", async () => {
    const k = new FakeHolders();
    keepers.push(k);
    const a = await bench("win", { holders: k });
    await a.st.open("lead@win");
    await a.call("lead@win", "open", { name: "docs", dir: a.dir, text: "Обнови README" });
    const kid = k.procs.get("docs@win")!;
    await until(() => kid.inputs.length === 1);
    kid.send(msg.state("running"));
    await until(() => a.st.kernel.sessions.get("docs@win")?.state === "busy");
    await a.st.close();
    stands.splice(stands.indexOf(a.st), 1);
    // ход кончился, пока Host нет: держатель копит вывод и отдаёт новому Host при подключении
    await until(() => kid.sock === null);
    kid.send(msg.assistant("работаю"));
    kid.send(msg.result({ result: "README обновлён" }));
    kid.send(msg.state("idle"));
    // relay нового Host ещё не прислал roster: родитель — только от manage этой машины
    await bench("win", { holders: k, home: a.st.home, holdRoster: true });
    const lead = k.procs.get("lead@win")!;
    await until(() => lead.inputs.length === 1);
    expect(lead.inputs[0]).toMatchObject({ priority: "next", message: { content: wrap("docs@win", "README обновлён") } });
  });

  it("312 · ход дочери начал человек — родителю ничего", async () => {
    const { st, call, dir } = await bench();
    await st.open("lead@win");
    await call("lead@win", "open", { name: "docs", dir, text: "Обнови README" });
    const kid = st.proc("docs@win");
    await until(() => kid.inputs.length === 1);
    st.session("host-fleet", "docs@win")!.input("Добавь тест на logout", { from: "phone~owner@example.com" });
    turn(kid, "работаю", { result: "тест добавлен" });
    await new Promise((r) => setTimeout(r, 30));
    expect(st.proc("lead@win").inputs).toHaveLength(0);
  });
});
