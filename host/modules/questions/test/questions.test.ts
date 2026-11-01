// Эталоны и стыки модуля questions на стенде Host: поддельные SDK, relay, keeper и часы.
// Рядом — настоящий watch (зрители) и поддельный push, записывающий notify.
import { afterEach, describe, expect, it } from "vitest";
import { stand } from "@switchboard/host";
import type { Frame, Manifest, Module } from "@switchboard/host";
import manifest from "../module.json" with { type: "json" };
import watchManifest from "../../watch/module.json" with { type: "json" };
import { make as makeWatch } from "../../watch/src/watch.ts";
import { make } from "../src/questions.ts";

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
  const st = await standHost({
    ...o,
    modules: [{ manifest: watchManifest as Manifest, module: makeWatch() }, push, { manifest: manifest as Manifest, module: o.mod ?? make() }],
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

  it("question.list — ждущие вопросы сессии; после ответа пусто; запись в хранилище стёрта", async () => {
    const { st } = await bench();
    const s = await st.open(CS);
    s.input("задача", { from: "phone~owner@example.com" });
    const asked = st.proc(CS).ask("AskUserQuestion", ASK, "toolu_l");
    await until(() => questions(st)[0]);
    expect(st.session("host-questions", CS)!.store().get()).toEqual({ toolu_l: ["phone~owner@example.com"] });
    expect(await st.relay.request({ type: "question.list", v: 1, callsign: CS })).toMatchObject({ ok: true, result: [{ question: "toolu_l", kind: "ask", questions: ASK.questions }] });
    await answer(st, "phone~owner@example.com", { question: "toolu_l", answers: pick("прод") });
    await asked;
    expect(await st.relay.request({ type: "question.list", v: 1, callsign: CS })).toMatchObject({ ok: true, result: [] });
    expect(st.session("host-questions", CS)!.store().get()).toBeUndefined();
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

  it("result сессии стирает её записи в разделе", async () => {
    const { st } = await bench();
    await st.open(CS);
    st.session("host-questions", CS)!.store().set({ toolu_old: ["phone~owner@example.com"] });
    stand.turn(st.proc(CS));
    await until(() => st.session("host-questions", CS)!.store().get() === undefined);
  });
});
