// Эталоны управления сессиями из сессии: инструменты fleet open, history, update, remove, list и итог хода родителю.
// Стенд Host: поддельные SDK, relay, держатели и часы; manage — настоящий, slots и profiles — поддельные модули стенда.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stand } from "@switchboard/host";
import type { Frame, Manifest } from "@switchboard/host";
import manifest from "../module.json" with { type: "json" };
import { make, task, wrap } from "../src/fleet.ts";
import { manage } from "../../manage/src/manage.ts";
import { make as makeChat } from "../../chat/src/chat.ts";
import { make as makePush } from "../../push/src/push.ts";
import { make as makeQuestions } from "../../questions/src/questions.ts";
import { make as makeWatch } from "../../watch/src/watch.ts";

const { FakeHolders, FakeRelay, module, msg, standHost, turn, until } = stand;
type Stand = stand.Stand;
const json = (name: string) => JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", name, "module.json"), "utf8")) as Manifest;
const manageManifest = json("manage");

const stands: Stand[] = [];
const keepers: stand.FakeHolders[] = [];
afterEach(async () => {
  for (const s of stands.splice(0)) await s.close();
  for (const k of keepers.splice(0)) await k.close();
});

/** Host с fleet и настоящим manage; dir — папка для session.open; home и holders — для перезапуска Host; holdRoster — relay ещё не прислал roster; withQuestions — настоящие questions, watch и push. */
async function bench(machine = "win", o: { home?: string; holders?: stand.FakeHolders; holdRoster?: boolean; withQuestions?: boolean } = {}) {
  const f = make();
  const dir = mkdtempSync(join(tmpdir(), "switchboard-fleet-"));
  const slots = module("host-slots", { requests: { "session.slot": () => ({ restart: false }) } });
  const profiles = module("host-profiles", { requests: { "session.profile": () => ({ restart: false }) } });
  const relay = new FakeRelay();
  relay.holdRoster = !!o.holdRoster;
  const ask = o.withQuestions
    ? [
        { manifest: json("watch"), module: makeWatch() },
        { manifest: json("push"), module: makePush() },
        { manifest: json("questions"), module: makeQuestions() },
      ]
    : [];
  const st = await standHost({
    machine,
    home: o.home,
    holders: o.holders,
    relayStand: relay,
    modules: [slots, profiles, ...ask, { manifest: manageManifest, module: manage({ home: dir }) }, { manifest: manifest as Manifest, module: f.module }],
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
function roster(st: Stand, sessions: Array<{ callsign: string; parent?: string; [k: string]: unknown }>) {
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
    // задача от родителя — с подсказкой: итог хода уйдёт ему сам (живой прогон 1 нояб.: без неё дочь отвечала fleet.send)
    expect(st.proc("docs@win").inputs[0].message.content).toBe(task("lead@win", "Обнови README"));
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
    roster(st, [{ callsign: "lead@win", cost: 1 }, { callsign: "fix-auth@wsl", parent: "lead@win" }]);
    await new Promise((r) => setTimeout(r, 10));
    const r = JSON.parse((await call("lead@win", "list", {})).content[0].text);
    expect(r.me).toBe("lead@win");
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

/** Ответ relay на запрос type, ушедший с этого Host. */
async function replyTo(st: Stand, type: string, r: Record<string, unknown>, i = 0) {
  const f = await until(() => st.relay.frames(type)[i]);
  st.relay.deliver({ type: "reply", id: f.id as string, ...r } as Frame);
  return f;
}

describe("эталоны: сессия ведёт другие сессии — отказы и ветки итога", () => {
  it("326 · open, history, remove: машины нет на связи — модели «Не доставлено … (offline)»; после отказа open задача не уходит", async () => {
    // источник: принятый дизайн, ожидаемые ветки — «Адресата нет на связи: send, open, history — Отказ offline словом в ответе инструмента… Повторов нет»
    const { st, call } = await bench();
    await st.open("lead@win");
    const o = call("lead@win", "open", { name: "fix-auth", machine: "wsl", dir: "~/app", text: "Почини вход" });
    await replyTo(st, "session.open", { ok: false, error: "offline" });
    expect(await o).toEqual({ content: [{ type: "text", text: "Не доставлено: fix-auth@wsl не на связи (offline)" }], isError: true });
    const h = call("lead@win", "history", { callsign: "fix-auth@wsl" });
    await replyTo(st, "session.history", { ok: false, error: "offline" });
    expect((await h).content[0].text).toBe("Не доставлено: fix-auth@wsl не на связи (offline)");
    const r = call("lead@win", "remove", { callsign: "fix-auth@wsl" });
    await replyTo(st, "session.remove", { ok: false, error: "offline" });
    expect((await r).content[0].text).toBe("Не доставлено: fix-auth@wsl не на связи (offline)");
    expect(st.relay.frames("message")).toHaveLength(0);
  });

  it("327 · open: имя занято — модели «Не выполнено: docs@win — name_taken»; задача не уходит, новой сессии нет", async () => {
    // источник: устав — ошибки словами; слово — чьё: код (manage), текст — чьё: код (fleet)
    const { st, call, dir } = await bench();
    await st.open("lead@win");
    await call("lead@win", "open", { name: "docs", dir, text: "Обнови README" });
    await until(() => st.proc("docs@win").inputs.length === 1);
    const r = await call("lead@win", "open", { name: "docs", dir, text: "Ещё раз" });
    expect(r).toEqual({ content: [{ type: "text", text: "Не выполнено: docs@win — name_taken" }], isError: true });
    await new Promise((x) => setTimeout(x, 20));
    expect(st.proc("docs@win").inputs).toHaveLength(1);
    expect([...st.kernel.sessions.keys()].sort()).toEqual(["docs@win", "lead@win"]);
  });

  it("328 · update: усилие не того вида — модели «Не выполнено: docs@win — bad_spec»; SDK дочери не вызван", async () => {
    // источник: устав — ошибки словами; слово — чьё: код (manage), текст — чьё: код (fleet)
    const { st, call, dir } = await bench();
    await st.open("lead@win");
    await call("lead@win", "open", { name: "docs", dir, text: "x" });
    const r = await call("lead@win", "update", { callsign: "docs@win", effort: "huge" });
    expect(r).toEqual({ content: [{ type: "text", text: "Не выполнено: docs@win — bad_spec" }], isError: true });
    expect(st.query("docs@win").calls.filter((c) => c.name === "applyFlagSettings" || c.name === "setModel")).toEqual([]);
  });

  it("329 · дочь закрыла себя в ходе, начатом родителем, — итог всё равно у родителя, затем дочь убрана", async () => {
    // источник: принятый дизайн, remove — «без позывного — себя, после конца этого хода: ход не обрывается, ответ успевает уйти»
    const { st, call, dir } = await bench();
    await st.open("lead@win");
    await call("lead@win", "open", { name: "docs", dir, text: "Обнови README и закройся" });
    const kid = st.proc("docs@win");
    await until(() => kid.inputs.length === 1);
    kid.send(msg.state("running"));
    await until(() => st.kernel.sessions.get("docs@win")!.state === "busy");
    expect((await call("docs@win", "remove", {})).content[0].text).toBe("закроюсь после этого хода");
    kid.send(msg.result({ result: "Готово, закрываюсь" }));
    kid.send(msg.state("idle"));
    const lead = st.proc("lead@win");
    await until(() => lead.inputs.length === 1);
    expect(lead.inputs[0]).toMatchObject({ message: { content: wrap("docs@win", "Готово, закрываюсь") } });
    await until(() => !st.kernel.sessions.has("docs@win"));
  });

  it("330 · ход дочери, начатый родителем, кончился ошибкой — родителю «ход кончился: error_during_execution»", async () => {
    // источник: чьё: код (fleet: итог хода не success — слово сбоя)
    const { st, call, dir } = await bench();
    await st.open("lead@win");
    await call("lead@win", "open", { name: "docs", dir, text: "Обнови README" });
    const kid = st.proc("docs@win");
    await until(() => kid.inputs.length === 1);
    kid.send(msg.state("running"));
    kid.send(msg.result({ subtype: "error_during_execution", is_error: true }));
    kid.send(msg.state("idle"));
    const lead = st.proc("lead@win");
    await until(() => lead.inputs.length === 1);
    expect(lead.inputs[0].message.content).toBe(wrap("docs@win", "ход кончился: error_during_execution"));
  });

  it("331 · процесс дочери умер посреди хода — один resume, итога нет: родителю ничего", async () => {
    // источник: принятый дизайн, ожидаемые ветки — «Процесс дочери умер посреди хода — Host: один resume… Ход потерян, итога нет»
    const { st, call, dir } = await bench();
    await st.open("lead@win");
    await call("lead@win", "open", { name: "docs", dir, text: "Обнови README" });
    const kid = st.proc("docs@win");
    await until(() => kid.inputs.length === 1);
    kid.send(msg.state("running"));
    await until(() => st.kernel.sessions.get("docs@win")!.state === "busy");
    kid.exit(1, "умер");
    await until(() => st.sdk.of("docs@win").length === 2 && st.kernel.sessions.get("docs@win")!.state === "idle");
    await new Promise((r) => setTimeout(r, 30));
    expect(st.proc("lead@win").inputs).toHaveLength(0);
  });

  it("332 · родителя нет на связи, когда пришёл итог, — строка журнала report со словом offline на машине дочери, повторов нет", async () => {
    // источник: принятый дизайн, ожидаемые ветки — «Родителя нет на связи, когда пришёл итог — Отказ offline, строка в журнале машины дочери»
    const { st, call, dir } = await bench();
    await st.open("lead@win");
    await call("lead@win", "open", { name: "docs", dir, text: "Обнови README" });
    const kid = st.proc("docs@win");
    await until(() => kid.inputs.length === 1);
    expect(await st.relay.request({ type: "session.remove", v: 1, callsign: "lead@win" })).toMatchObject({ ok: true });
    turn(kid, "работаю", { result: "README обновлён" });
    const line = await until(() => st.journal().find((l) => l.ev === "report"));
    expect(line).toMatchObject({ kind: "note", word: "offline", callsign: "docs@win" });
    await new Promise((r) => setTimeout(r, 30));
    expect(st.journal().filter((l) => l.ev === "report")).toHaveLength(1);
  });

  it("333 · родитель отвечает на вопрос дочери своей машины: вопрос во вводе родителя тегом fleet-question; ответ fleet.answer — у модели дочери; answered от родителя", async () => {
    // источник: принятый дизайн, инструменты модели — «answer — ответ на вопрос дочери»; устав — первый ответ выигрывает
    const { st, call, dir } = await bench("win", { withQuestions: true });
    await st.open("lead@win");
    st.session("host-fleet", "lead@win")!.input("Наведи порядок в документации", { from: "phone~owner@example.com" });
    await call("lead@win", "open", { name: "docs", dir, text: "Обнови README" });
    const kid = st.proc("docs@win");
    await until(() => kid.inputs.length === 1);
    const asked = kid.ask("AskUserQuestion", { questions: [{ question: "Какой README?" }] }, "toolu_k1");
    const q = await until(() => st.relay.frames("question")[0]);
    expect(q).toMatchObject({ from: "docs@win", to: ["lead@win"], question: "toolu_k1" });
    st.relay.deliver(q);
    const lead = st.proc("lead@win");
    await until(() => lead.inputs.length === 2);
    expect(lead.inputs[1].message.content).toContain('<fleet-question from="docs@win" question="toolu_k1">');
    expect((await call("lead@win", "answer", { to: "docs@win", question: "toolu_k1", answers: { "Какой README?": "корневой" } })).content[0].text).toBe("принято");
    expect(await asked).toMatchObject({ behavior: "allow", updatedInput: { answers: { "Какой README?": "корневой" } } });
    expect(st.relay.frames("answered")).toEqual([expect.objectContaining({ from: "docs@win", question: "toolu_k1", by: "lead@win" })]);
  });

  it("334 · вопрос дочери уже закрыт ответом человека — fleet.answer родителя: «Не выполнено: docs@win — already_answered»; у модели дочери ответ человека", async () => {
    // источник: устав — первый ответ выигрывает; слово — чьё: код (questions), текст — чьё: код (fleet)
    const { st, call, dir } = await bench("win", { withQuestions: true });
    await st.open("lead@win");
    await call("lead@win", "open", { name: "docs", dir, text: "Обнови README" });
    const kid = st.proc("docs@win");
    await until(() => kid.inputs.length === 1);
    const asked = kid.ask("AskUserQuestion", { questions: [{ question: "Какой README?" }] }, "toolu_k2");
    await until(() => st.relay.frames("question")[0]);
    expect(await st.relay.request({ type: "answer", v: 1, callsign: "docs@win", question: "toolu_k2", answers: { "Какой README?": "в docs" }, from: "phone~owner@example.com" })).toMatchObject({ ok: true });
    const r = await call("lead@win", "answer", { to: "docs@win", question: "toolu_k2", answers: { "Какой README?": "корневой" } });
    expect(r).toEqual({ content: [{ type: "text", text: "Не выполнено: docs@win — already_answered" }], isError: true });
    expect(await asked).toMatchObject({ behavior: "allow", updatedInput: { answers: { "Какой README?": "в docs" } } });
    expect(st.relay.frames("answered")).toEqual([expect.objectContaining({ question: "toolu_k2", by: "phone~owner@example.com" })]);
  });
});

describe("fleet: покрытие плана host-modules — управление", () => {
  it("3025 · open: сессия открыта, задача не доставлена — модели «открыта: …, но задача не доставлена — offline»", async () => {
    // источник: чьё: код (fleet.ts:121)
    const { st, call } = await bench();
    await st.open("lead@win");
    const o = call("lead@win", "open", { name: "fix", machine: "wsl", dir: "~/app", text: "Почини" });
    await replyTo(st, "session.open", { ok: true, result: { callsign: "fix@wsl", session_id: "s1" } });
    await replyTo(st, "message", { ok: false, error: "offline" });
    expect(await o).toEqual({ content: [{ type: "text", text: "открыта: fix@wsl, но задача не доставлена — offline" }], isError: true });
  });

  it("3026 · history и remove сессии, которой нет на этой машине, — module_error текстом; chat и manage живы", async () => {
    // источник: чьё: код (kernel.ts:492-506 «сбой владельца — отказ module_error, а не выключение модуля»; fleet.ts:39)
    const f = make();
    const dir = mkdtempSync(join(tmpdir(), "switchboard-fleet-"));
    const st = await standHost({
      machine: "win",
      modules: [
        module("host-slots", { requests: { "session.slot": () => ({ restart: false }) } }),
        module("host-profiles", { requests: { "session.profile": () => ({ restart: false }) } }),
        { manifest: json("chat"), module: makeChat() },
        { manifest: manageManifest, module: manage({ home: dir }) },
        { manifest: manifest as Manifest, module: f.module },
      ],
    });
    stands.push(st);
    const call = async (me: string, name: string, args: Record<string, unknown>) =>
      (await f.tools(me).find((x) => x.name === name)!.handler(args as never, {})) as { content: Array<{ text: string }>; isError?: boolean };
    await st.open("lead@win");
    await st.open("docs@win");
    expect(await call("lead@win", "history", { callsign: "nope@win" })).toEqual({ content: [{ type: "text", text: "Не выполнено: nope@win — module_error" }], isError: true });
    expect(await call("lead@win", "remove", { callsign: "nope@win" })).toEqual({ content: [{ type: "text", text: "Не выполнено: nope@win — module_error" }], isError: true });
    st.sdk.functions = { getSessionMessages: async () => [{ type: "user", uuid: "u1", message: { content: "привет" } }] };
    expect((await call("lead@win", "history", { callsign: "docs@win" })).content[0].text).toBe("user: привет");
    expect((await call("lead@win", "remove", { callsign: "docs@win" })).content[0].text).toBe("закрыта: docs@win");
  });

  it("3027 · update остановленной — «сразу: —»; модель — со следующего старта", async () => {
    // источник: чьё: код (fleet.ts:140; manage.ts:207)
    const { st, call, dir } = await bench();
    await st.open("lead@win");
    await call("lead@win", "open", { name: "docs", dir, text: "x" });
    await st.session("host-fleet", "docs@win")!.stop();
    expect((await call("lead@win", "update", { callsign: "docs@win", model: "sonnet" })).content[0].text).toBe("сразу: —");
    expect(await st.relay.request({ type: "session.start", v: 1, callsign: "docs@win" })).toMatchObject({ ok: true });
    expect(st.query("docs@win").options).toMatchObject({ model: "sonnet" });
  });
});
