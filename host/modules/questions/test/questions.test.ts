// Эталоны и стыки модуля questions на стенде Host: поддельные SDK, relay, keeper и часы.
// Рядом — настоящий watch (зрители) и поддельный push, записывающий notify.
import { afterEach, describe, expect, it } from "vitest";
import { stand } from "@switchboard/host";
import type { Frame, Manifest, Module } from "@switchboard/host";
import manifest from "../module.json" with { type: "json" };
import watchManifest from "../../watch/module.json" with { type: "json" };
import { make as makeWatch } from "../../watch/src/watch.ts";
import { make } from "../src/questions.ts";
import pushManifest from "../../push/module.json" with { type: "json" };
import { make as makePush } from "../../push/src/push.ts";

const { FakeHolders, module, standHost, until } = stand;
type Stand = stand.Stand;

const stands: Stand[] = [];
const keepers: stand.FakeHolders[] = [];
afterEach(async () => {
  for (const s of stands.splice(0)) await s.close();
  for (const k of keepers.splice(0)) await k.close();
});

const CS = "profiles@laptop";
const ASK = {
  questions: [
    {
      question: "Какую базу мигрировать первой?",
      header: "База",
      multiSelect: false,
      options: [
        { label: "прод", description: "боевая, 2 ТБ" },
        { label: "стенд", description: "копия за неделю" },
      ],
    },
  ],
};

async function bench(o: { holders?: stand.FakeHolders; home?: string; mod?: Module } = {}) {
  const notifies: Frame[] = [];
  const push = module("host-push", { requests: { notify: (req) => (notifies.push(req), { pushed: [] }) } });
  // режим держит manage: эти эталоны — про режим по умолчанию
  const manage = module("host-manage", { fields: { mode: () => "bypassPermissions" } });
  const st = await standHost({
    ...o,
    modules: [manage, { manifest: watchManifest as Manifest, module: makeWatch() }, push, { manifest: manifest as Manifest, module: o.mod ?? make() }],
  });
  stands.push(st);
  return { st, notifies };
}

async function keeper() {
  const k = new FakeHolders();
  keepers.push(k);
  return k;
}

const questions = (st: Stand) => st.relay.frames("question");
const answered = (st: Stand) => st.relay.frames("answered");
const answer = (st: Stand, from: string, o: Record<string, unknown>) => st.relay.request({ type: "answer", v: 1, callsign: CS, from, ...o });
const pick = (label: string) => ({ "Какую базу мигрировать первой?": label });

/** Пульт смотрит ленту сессии. */
const watchBy = (st: Stand, from: string) => st.relay.request({ type: "session.watch", v: 1, callsign: CS, from });

describe("эталоны questions", () => {
  it("11 · bypassPermissions: Bash без вопроса; AskUserQuestion — кадр question телефону, сессия ждёт", async () => {
    const { st } = await bench();
    const s = await st.open(CS);
    s.input("Мигрируй базы", { from: "phone~owner@example.com" });
    const p = st.proc(CS);
    expect(await p.ask("Bash", { command: "npm test" })).toMatchObject({ behavior: "allow" });
    expect(questions(st)).toHaveLength(0);
    let done = false;
    const a = p.ask("AskUserQuestion", ASK, "toolu_01Hq").then((r) => ((done = true), r));
    const q = await until(() => questions(st)[0]);
    expect(q).toMatchObject({ type: "question", from: CS, to: ["phone~owner@example.com"], question: "toolu_01Hq", kind: "ask", questions: ASK.questions });
    await new Promise((r) => setTimeout(r, 30));
    expect(done).toBe(false);
    await answer(st, "phone~owner@example.com", { question: "toolu_01Hq", answers: pick("стенд") });
    expect(await a).toEqual({ behavior: "allow", updatedInput: { ...ASK, answers: pick("стенд") } });
  });

  it("12 · гонка: чат ответил первым — его ответ в SDK; телефону already_answered; всем answered", async () => {
    const { st } = await bench();
    const s = await st.open(CS);
    await watchBy(st, "panel-desk~owner@example.com");
    s.input("Выбери цвет", { from: "phone~owner@example.com" });
    const a = st.proc(CS).ask("AskUserQuestion", { questions: [{ question: "Какой цвет?", header: "Цвет", multiSelect: false, options: [{ label: "Синий" }, { label: "Красный" }] }] }, "toolu_01Rc");
    const q = await until(() => questions(st)[0]);
    expect(q.to).toEqual(["phone~owner@example.com", "panel-desk~owner@example.com"]);
    expect(await answer(st, "panel-desk~owner@example.com", { question: "toolu_01Rc", answers: { "Какой цвет?": "Синий" } })).toMatchObject({ ok: true });
    expect(await answer(st, "phone~owner@example.com", { question: "toolu_01Rc", answers: { "Какой цвет?": "Красный" } })).toMatchObject({ ok: false, error: "already_answered" });
    expect(await a).toMatchObject({ behavior: "allow", updatedInput: { answers: { "Какой цвет?": "Синий" } } });
    expect(answered(st)).toEqual([expect.objectContaining({ question: "toolu_01Rc", by: "panel-desk~owner@example.com", to: ["phone~owner@example.com", "panel-desk~owner@example.com"], answers: { "Какой цвет?": "Синий" } })]);
  });

  it("13 · Host умер с ждущим вопросом, новый сделал attach: тот же toolUseID, ответ дошёл до модели", async () => {
    const k = await keeper();
    const a = await bench({ holders: k });
    const s = await a.st.open(CS);
    s.input("задача", { from: "panel-desk~owner@example.com" });
    const p = a.st.proc(CS);
    const asked = p.ask("AskUserQuestion", ASK, "toolu_xd4WEnP8");
    await until(() => questions(a.st)[0]);
    a.st.crash();
    await until(() => p.sock === null);
    const b = await bench({ holders: k, home: a.st.home });
    const q = await until(() => questions(b.st)[0]);
    expect(q).toMatchObject({ question: "toolu_xd4WEnP8", to: ["panel-desk~owner@example.com"] });
    expect(await answer(b.st, "panel-desk~owner@example.com", { question: "toolu_xd4WEnP8", answers: pick("прод") })).toMatchObject({ ok: true });
    expect(await asked).toMatchObject({ behavior: "allow", updatedInput: { answers: pick("прод") } });
  });

  it("72 · stop с причиной upgrade: canUseTool не получил ни allow, ни deny; новый Host — тот же id телефону; ответ дошёл", async () => {
    const k = await keeper();
    const a = await bench({ holders: k });
    const s = await a.st.open(CS);
    s.input("задача", { from: "phone~owner@example.com" });
    const p = a.st.proc(CS);
    let settled = false;
    const asked = p.ask("AskUserQuestion", ASK, "toolu_01Hq").then((r) => ((settled = true), r));
    await until(() => questions(a.st)[0]);
    await a.st.close();
    stands.splice(stands.indexOf(a.st), 1);
    await new Promise((r) => setTimeout(r, 30));
    expect(settled).toBe(false);
    expect(p.alive).toBe(true);
    const b = await bench({ holders: k, home: a.st.home });
    const q = await until(() => questions(b.st)[0]);
    expect(q).toMatchObject({ question: "toolu_01Hq", to: ["phone~owner@example.com"] });
    await answer(b.st, "phone~owner@example.com", { question: "toolu_01Hq", answers: pick("стенд") });
    expect(await asked).toMatchObject({ behavior: "allow", updatedInput: { answers: pick("стенд") } });
  });

  it("73 · форма MCP: question kind form со схемой — panel-desk; первый answer — accept с content; второй — already_answered", async () => {
    const { st } = await bench();
    const s = await st.open(CS);
    s.input("Заведи задачу", { from: "panel-desk~owner@example.com" });
    const schema = { type: "object", properties: { project: { type: "string" } } };
    const r = st.proc(CS).elicit({ serverName: "jira", message: "Данные для новой задачи", mode: "form", requestedSchema: schema });
    const q = await until(() => questions(st)[0]);
    expect(q).toMatchObject({ kind: "form", server: "jira", message: "Данные для новой задачи", schema, to: ["panel-desk~owner@example.com"] });
    const id = q.question as string;
    expect(await answer(st, "panel-desk~owner@example.com", { question: id, content: { project: "WEB" } })).toMatchObject({ ok: true });
    expect(await answer(st, "phone~owner@example.com", { question: id, content: { project: "OPS" } })).toMatchObject({ ok: false, error: "already_answered" });
    expect(await r).toEqual({ action: "accept", content: { project: "WEB" } });
  });

  it("74 · Host упал с ждущей формой: новый Host её не знает — unknown_question со строкой в журнале; вопросы дальше работают", async () => {
    const k = await keeper();
    const a = await bench({ holders: k });
    const s = await a.st.open(CS);
    s.input("Заведи задачу", { from: "panel-desk~owner@example.com" });
    const p = a.st.proc(CS);
    void p.elicit({ serverName: "jira", message: "Данные", mode: "form", requestedSchema: { type: "object", properties: {} } });
    const id = (await until(() => questions(a.st)[0])).question as string;
    a.st.crash();
    await until(() => p.sock === null);
    const b = await bench({ holders: k, home: a.st.home });
    await until(() => b.st.session("host-questions", CS)?.state === "idle");
    expect(await answer(b.st, "panel-desk~owner@example.com", { question: id, content: { project: "WEB" } })).toMatchObject({ ok: false, error: "unknown_question" });
    expect(b.st.journal().some((l) => l.word === "unknown_question" && l.who === "host-questions" && l.kind === "refuse")).toBe(true);
    await watchBy(b.st, "panel-desk~owner@example.com");
    const asked = p.ask("AskUserQuestion", ASK, "toolu_next");
    await until(() => questions(b.st).find((f) => f.question === "toolu_next"));
    await answer(b.st, "panel-desk~owner@example.com", { question: "toolu_next", answers: pick("прод") });
    expect(await asked).toMatchObject({ behavior: "allow" });
  });

  it("159 · вопрос телефону и зрителю panel-desk: кадр без notify, один notify с tag; после ответа — answered и второй notify с тем же tag", async () => {
    const { st, notifies } = await bench();
    const s = await st.open(CS);
    await watchBy(st, "panel-desk~owner@example.com");
    s.input("задача", { from: "phone~owner@example.com" });
    const asked = st.proc(CS).ask("AskUserQuestion", ASK, "toolu_01Hq");
    const q = await until(() => questions(st)[0]);
    expect(q.to).toEqual(["phone~owner@example.com", "panel-desk~owner@example.com"]);
    expect(q).not.toHaveProperty("notify");
    await until(() => notifies.length === 1);
    expect(notifies[0]).toMatchObject({
      clients: ["phone~owner@example.com", "panel-desk~owner@example.com"],
      frame: {
        type: "question",
        from: CS,
        notify: {
          title: `${CS} спрашивает`,
          body: "Какую базу мигрировать первой?",
          actions: [
            { title: "прод", frame: { type: "answer", v: 1, callsign: CS, question: "toolu_01Hq", answers: pick("прод") } },
            { title: "стенд", frame: { type: "answer", v: 1, callsign: CS, question: "toolu_01Hq", answers: pick("стенд") } },
          ],
          tag: "toolu_01Hq",
        },
      },
    });
    await answer(st, "panel-desk~owner@example.com", { question: "toolu_01Hq", answers: pick("стенд") });
    await asked;
    expect(answered(st)[0]).toMatchObject({ to: ["phone~owner@example.com", "panel-desk~owner@example.com"], by: "panel-desk~owner@example.com" });
    await until(() => notifies.length === 2);
    expect(notifies[1]).toMatchObject({ clients: ["phone~owner@example.com", "panel-desk~owner@example.com"], frame: { type: "answered", notify: { title: `${CS} · ответ принят`, body: "panel-desk~owner@example.com: стенд", tag: "toolu_01Hq" } } });
  });
});

describe("questions: стыки и юнит", () => {
  it("ход прервали: signal — answered cancelled всем, deny; поздний answer — already_answered", async () => {
    const mod = make();
    const { st } = await bench({ mod });
    const s = await st.open(CS);
    s.input("задача", { from: "phone~owner@example.com" });
    const ac = new AbortController();
    const r = mod.decide!.AskUserQuestion(st.session("host-questions", CS)!, ASK, { toolUseID: "toolu_c", signal: ac.signal });
    await until(() => questions(st)[0]);
    ac.abort();
    expect(await r).toEqual({ behavior: "deny", message: "cancelled" });
    expect(answered(st)[0]).toMatchObject({ question: "toolu_c", cancelled: true, to: ["phone~owner@example.com"] });
    expect(answered(st)[0]).not.toHaveProperty("by");
    expect(await answer(st, "phone~owner@example.com", { question: "toolu_c", answers: pick("прод") })).toMatchObject({ ok: false, error: "already_answered" });
  });

  it("question.list — ждущие вопросы сессии; после ответа пусто", async () => {
    const { st } = await bench();
    const s = await st.open(CS);
    s.input("задача", { from: "phone~owner@example.com" });
    const asked = st.proc(CS).ask("AskUserQuestion", ASK, "toolu_l");
    await until(() => questions(st)[0]);
    expect(await st.relay.request({ type: "question.list", v: 1, callsign: CS })).toMatchObject({ ok: true, result: [{ question: "toolu_l", kind: "ask", questions: ASK.questions }] });
    await answer(st, "phone~owner@example.com", { question: "toolu_l", answers: pick("прод") });
    await asked;
    expect(await st.relay.request({ type: "question.list", v: 1, callsign: CS })).toMatchObject({ ok: true, result: [] });
  });

  it("задачу дала сессия: кадр question для неё — в её ввод тегом fleet-question с priority next", async () => {
    const { st } = await bench();
    await st.open("api@laptop");
    st.relay.deliver({ type: "question", from: CS, to: ["api@laptop"], question: "toolu_p", kind: "ask", questions: ASK.questions });
    const p = st.proc("api@laptop");
    await until(() => p.inputs.length === 1);
    const text = p.inputs[0].message.content as string;
    expect(p.inputs[0]).toMatchObject({ priority: "next", origin: { kind: "peer", from: CS } });
    expect(text).toContain(`<fleet-question from="${CS}" question="toolu_p">`);
    expect(text).toContain("· прод — боевая, 2 ТБ");
    expect(text).toContain("fleet.answer");
  });

  it("answer без answers — bad_frame; чужой callsign — unknown_question", async () => {
    const { st } = await bench();
    const s = await st.open(CS);
    await st.open("wiki@laptop");
    s.input("задача", { from: "phone~owner@example.com" });
    const asked = st.proc(CS).ask("AskUserQuestion", ASK, "toolu_b");
    await until(() => questions(st)[0]);
    expect(await answer(st, "phone~owner@example.com", { question: "toolu_b" })).toMatchObject({ ok: false, error: "bad_frame" });
    expect(await st.relay.request({ type: "answer", v: 1, callsign: "wiki@laptop", question: "toolu_b", answers: pick("прод") })).toMatchObject({ ok: false, error: "unknown_question" });
    await answer(st, "phone~owner@example.com", { question: "toolu_b", answers: pick("прод") });
    await asked;
  });
});

/** Host win с настоящими watch, push и questions: вопрос дочери родителю на одной машине. */
async function nest() {
  const st = await standHost({
    machine: "win",
    modules: [{ manifest: watchManifest as Manifest, module: makeWatch() }, { manifest: pushManifest as Manifest, module: makePush() }, { manifest: manifest as Manifest, module: make() }],
  });
  stands.push(st);
  return st;
}

describe("эталоны questions: вложенные сессии", () => {
  it("337 · вопрос дочери во вводе родителя не меняет адресата вопросов родителя: следующий вопрос родителя — тому, кто дал ему задачу", async () => {
    // источник: устав — AskUserQuestion получает тот, кто дал задачу; слово пользователя «контроль вложенных как в десктопе»
    // (проход архитектора по ядру сессий: «вопрос родителя уходит тому, кто дал ему задачу, а не дочери»)
    const st = await nest();
    const lead = await st.open("lead@win");
    lead.input("Наведи порядок в документации", { from: "phone~owner@example.com" });
    st.relay.deliver({ type: "question", from: "docs@win", to: ["lead@win"], question: "toolu_k1", kind: "ask", questions: [{ question: "Какой README?" }] });
    const p = st.proc("lead@win");
    await until(() => p.inputs.length === 2);
    expect(p.inputs[1].message.content).toContain('<fleet-question from="docs@win" question="toolu_k1">');
    void p.ask("AskUserQuestion", { questions: [{ question: "Можно пушить в main?" }] }, "toolu_l1");
    const q = await until(() => questions(st)[0]);
    expect(q).toMatchObject({ from: "lead@win", question: "toolu_l1", to: ["phone~owner@example.com"] });
  });

  it("338 · форма MCP дочери родителю-сессии не адресуется и в его ввод не кладётся: только клиенты", async () => {
    // источник: чьё: код (questions: форма и ссылка — только человеку)
    const st = await nest();
    await st.open("lead@win");
    const docs = await st.open("docs@win");
    await st.relay.request({ type: "session.watch", v: 1, callsign: "docs@win", from: "pult~a@b" });
    docs.input("задача", { from: "lead@win" });
    void st.proc("docs@win").elicit({ serverName: "github", message: "Войти в GitHub", mode: "form", requestedSchema: {} });
    const q = await until(() => st.relay.frames("question")[0]);
    expect(q).toMatchObject({ kind: "form", to: ["pult~a@b"] });
    await new Promise((r) => setTimeout(r, 20));
    expect(st.proc("lead@win").inputs).toHaveLength(0);
  });
});

describe("questions: покрытие плана host-modules", () => {
  it("3018 · вопрос сессии-родителю другой машины — кадр ей, пуша нет", async () => {
    // источник: чьё: код (questions.ts:61, :65-67 — пуш только клиентам)
    const { st, notifies } = await bench();
    const s = await st.open(CS);
    s.input("задача", { from: "lead@other" });
    void st.proc(CS).ask("AskUserQuestion", ASK, "toolu_par");
    const q = await until(() => questions(st)[0]);
    expect(q.to).toEqual(["lead@other"]);
    await new Promise((r) => setTimeout(r, 20));
    expect(notifies).toHaveLength(0);
  });

  it("3019 · watch не ответил — вопрос давшему задачу, строка журнала stop со словом", async () => {
    // источник: чьё: код (questions.ts:57-59); устав «система ловит … пишет в журнал»
    const watch = module("host-watch", { requests: { "session.watchers": () => { throw new Error("watch упал"); } } });
    const push = module("host-push", { requests: { notify: () => ({ pushed: [] }) } });
    const st = await standHost({ modules: [watch, push, { manifest: manifest as Manifest, module: make() }] });
    stands.push(st);
    const s = await st.open(CS);
    s.input("задача", { from: "phone~owner@example.com" });
    void st.proc(CS).ask("AskUserQuestion", ASK, "toolu_w");
    const q = await until(() => questions(st)[0]);
    expect(q.to).toEqual(["phone~owner@example.com"]);
    expect(st.journal().find((l) => l.ev === "question" && l.kind === "stop")).toMatchObject({ word: "module_error", callsign: CS });
  });

  it("3020 · адресатов нет — кадра нет, вопрос ждёт в question.list", async () => {
    // источник: чьё: код (questions.ts:97-99)
    const { st } = await bench();
    const s = await st.open(CS);
    s.input("задача", { from: "@laptop" });
    void st.proc(CS).ask("AskUserQuestion", ASK, "toolu_none");
    const line = await until(() => st.journal().find((l) => l.ev === "question" && l.question === "toolu_none"));
    expect(line.why).toContain("адресатов нет");
    expect(questions(st)).toHaveLength(0);
    expect(await st.relay.request({ type: "question.list", v: 1, callsign: CS })).toMatchObject({ ok: true, result: [{ question: "toolu_none", kind: "ask" }] });
  });

  it("3021 · несколько вопросов или multiSelect — пуш без кнопок", async () => {
    // источник: чьё: код (questions.ts:75-81)
    const { st, notifies } = await bench();
    const s = await st.open(CS);
    s.input("задача", { from: "phone~owner@example.com" });
    void st.proc(CS).ask("AskUserQuestion", { questions: [ASK.questions[0], { question: "Ещё?", options: [{ label: "да" }] }] }, "toolu_two");
    await until(() => notifies.length === 1);
    expect((notifies[0].frame as { notify: Record<string, unknown> }).notify).not.toHaveProperty("actions");
    void st.proc(CS).ask("AskUserQuestion", { questions: [{ ...ASK.questions[0], multiSelect: true }] }, "toolu_multi");
    await until(() => notifies.length === 2);
    expect((notifies[1].frame as { notify: Record<string, unknown> }).notify).not.toHaveProperty("actions");
  });

  it("3022 · форма-ссылка — kind url; ответ decline — в SDK", async () => {
    // источник: чьё: код (questions.ts:133-137)
    const { st } = await bench();
    const s = await st.open(CS);
    s.input("Войди", { from: "phone~owner@example.com" });
    const r = st.proc(CS).elicit({ serverName: "github", message: "Войти", mode: "url", url: "https://github.com/login" });
    const q = await until(() => questions(st)[0]);
    expect(q).toMatchObject({ kind: "url", server: "github", url: "https://github.com/login" });
    expect(await answer(st, "phone~owner@example.com", { question: q.question, action: "decline" })).toMatchObject({ ok: true });
    expect(await r).toEqual({ action: "decline" });
  });

  it("3023 · форма: ход прервали — cancel, answered cancelled", async () => {
    // источник: чьё: код (questions.ts:136)
    const mod = make();
    const { st } = await bench({ mod });
    const s = await st.open(CS);
    s.input("задача", { from: "phone~owner@example.com" });
    const ac = new AbortController();
    const r = mod.elicit!(st.session("host-questions", CS)!, { serverName: "jira", message: "Данные", mode: "form", requestedSchema: {} } as never, { signal: ac.signal, requestId: "el_c" });
    await until(() => questions(st)[0]);
    ac.abort();
    expect(await r).toEqual({ action: "cancel" });
    expect(answered(st)[0]).toMatchObject({ question: "el_c", cancelled: true });
  });
});
