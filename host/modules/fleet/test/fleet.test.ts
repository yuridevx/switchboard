// Эталоны и стыки модуля fleet на стенде Host: поддельные SDK, relay, keeper и часы.
// Инструменты MCP зовутся как их зовёт SDK — обработчиком tool() сервера сессии.
import { afterEach, describe, expect, it } from "vitest";
import { stand } from "@switchboard/host";
import type { Frame, Manifest, Module } from "@switchboard/host";
import manifest from "../module.json" with { type: "json" };
import { make, wrap } from "../src/fleet.ts";

const { FakeHolders, module, msg, standHost, turn, until } = stand;
type Stand = stand.Stand;

const stands: Stand[] = [];
const keepers: stand.FakeHolders[] = [];
afterEach(async () => {
  for (const s of stands.splice(0)) await s.close();
  for (const k of keepers.splice(0)) await k.close();
});

async function bench(o: { machine?: string; holders?: stand.FakeHolders; home?: string; extra?: ReturnType<typeof module>[] } = {}) {
  const f = make();
  const st = await standHost({ machine: o.machine, holders: o.holders, home: o.home, modules: [{ manifest: manifest as Manifest, module: f.module }, ...(o.extra ?? [])] });
  stands.push(st);
  /** Вызов инструмента MCP сессии me. */
  const call = async (me: string, name: string, args: Record<string, unknown>) => {
    const t = f.tools(me).find((x) => x.name === name)!;
    return (await t.handler(args as never, {})) as { content: Array<{ text: string }>; isError?: boolean };
  };
  return { st, call };
}

const input = (st: Stand, cs: string, i = 0) => st.proc(cs).inputs[i];

describe("эталоны fleet", () => {
  it("8 · message простаивающей poe-bot@pc от site@laptop: во вводе fleet-message с priority next; reply ok", async () => {
    const { st } = await bench({ machine: "pc" });
    await st.open("poe-bot@pc");
    const r = await st.relay.request({ type: "message", v: 1, from: "site@laptop", to: "poe-bot@pc", text: "Станция собрана. Прогони эталоны?" });
    expect(r).toMatchObject({ type: "reply", ok: true });
    expect(r).not.toHaveProperty("result");
    const p = st.proc("poe-bot@pc");
    await until(() => p.inputs.length === 1);
    expect(input(st, "poe-bot@pc")).toMatchObject({
      type: "user",
      priority: "next",
      origin: { kind: "peer", from: "site@laptop", name: "site@laptop" },
      message: { role: "user", content: '<fleet-message from="site@laptop">\nСтанция собрана. Прогони эталоны?\n</fleet-message>' },
    });
    expect(st.session("host-fleet", "poe-bot@pc")!.info.from).toBe("site@laptop");
  });

  it("9 · poe-bot выполняет Bash, посреди приходит message: команда не прервана, сообщение ждёт границы шага во вводе", async () => {
    const { st } = await bench({ machine: "pc" });
    const s = await st.open("poe-bot@pc");
    const p = st.proc("poe-bot@pc");
    p.send(msg.state("running"));
    p.send({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test" } }] }, parent_tool_use_id: null, session_id: "s" });
    await until(() => s.state === "busy");
    const r = await st.relay.request({ type: "message", v: 1, from: "site@laptop", to: "poe-bot@pc", text: "Станция собрана. Прогони эталоны?" });
    expect(r).toMatchObject({ ok: true });
    await until(() => p.inputs.length === 1);
    expect(input(st, "poe-bot@pc").priority).toBe("next");
    expect(p.interrupts).toBe(0);
    expect(s.state).toBe("busy");
    p.send(msg.result());
    p.send(msg.state("idle"));
    await until(() => s.state === "idle");
    expect(p.interrupts).toBe(0);
  });

  it("10 · две сессии в одном Host: api пишет docs через fleet.send, docs отвечает своим fleet.send", async () => {
    const { st, call } = await bench();
    await st.open("api@laptop");
    await st.open("docs@laptop");
    const r1 = await call("api@laptop", "send", { to: "docs@laptop", text: "Сколько будет 17*3?" });
    expect(r1).toEqual({ content: [{ type: "text", text: "доставлено: docs@laptop" }] });
    await until(() => st.proc("docs@laptop").inputs.length === 1);
    expect(input(st, "docs@laptop").message.content).toBe(wrap("api@laptop", "Сколько будет 17*3?"));
    const r2 = await call("docs@laptop", "send", { to: "api@laptop", text: "17*3 = 51" });
    expect(r2.content[0].text).toBe("доставлено: api@laptop");
    await until(() => st.proc("api@laptop").inputs.length === 1);
    expect(input(st, "api@laptop").message.content).toBe('<fleet-message from="docs@laptop">\n17*3 = 51\n</fleet-message>');
  });

  it("70 · fleet.send для wiki@pc, машины pc нет: relay отвечает offline — ошибка инструмента, сообщение нигде не осталось", async () => {
    const { st, call } = await bench();
    await st.open("site@laptop");
    const pending = call("site@laptop", "send", { to: "wiki@pc", text: "Обнови оглавление" });
    const f = await until(() => st.relay.frames("message")[0]);
    expect(f).toMatchObject({ type: "message", v: 1, from: "site@laptop", to: "wiki@pc", text: "Обнови оглавление" });
    st.relay.deliver({ type: "reply", id: f.id as string, ok: false, error: "offline" } as Frame);
    expect(await pending).toEqual({ isError: true, content: [{ type: "text", text: "Не доставлено: wiki@pc не на связи (offline)" }] });
    expect(st.relay.frames("message")).toHaveLength(1);
  });

  it("71 · stop upgrade посреди хода, взятого по message: новый message — shutting_down; ввод не тронут; новый Host не кладёт сообщение заново", async () => {
    const k = new FakeHolders();
    keepers.push(k);
    const a = await bench({ machine: "pc", holders: k });
    await a.st.open("poe-bot@pc");
    const p = a.st.proc("poe-bot@pc");
    expect(await a.st.relay.request({ type: "message", v: 1, from: "deploy", to: "poe-bot@pc", text: "Прогони эталоны" })).toMatchObject({ ok: true });
    await until(() => p.inputs.length === 1);
    p.send(msg.state("running"));
    void a.st.kernel.shutdown("upgrade");
    const late = await a.st.relay.request({ type: "message", v: 1, from: "deploy", to: "poe-bot@pc", text: "ещё" });
    expect(late).toMatchObject({ ok: false, error: "shutting_down" });
    await a.st.close();
    stands.splice(stands.indexOf(a.st), 1);
    expect(p.interrupts).toBe(0);
    expect(p.alive).toBe(true);
    // ход дошёл до конца у keeper
    p.send(msg.result({ user_message_uuids: [p.inputs[0].uuid] }));
    p.send(msg.state("idle"));
    const b = await bench({ machine: "pc", holders: k, home: a.st.home });
    await until(() => b.st.session("host-fleet", "poe-bot@pc")?.state === "idle");
    await new Promise((r) => setTimeout(r, 30));
    expect(p.inputs).toHaveLength(1);
  });
});

describe("fleet: инструменты и вклад", () => {
  it("message сессии, которой нет, — offline; остановленной — offline", async () => {
    const { st } = await bench();
    const s = await st.open("site@laptop");
    expect(await st.relay.request({ type: "message", v: 1, from: "deploy", to: "wiki@laptop", text: "x" })).toMatchObject({ ok: false, error: "offline" });
    await s.stop();
    expect(await st.relay.request({ type: "message", v: 1, from: "deploy", to: "site@laptop", text: "x" })).toMatchObject({ ok: false, error: "offline" });
  });

  it("fleet.list — выжимка последнего roster; до roster — disconnected", async () => {
    const { st: s2, call } = await bench();
    s2.relay.deliver({ type: "roster", machines: [], sessions: [{ callsign: "poe-bot@pc", state: "busy", cost: 1 }, { callsign: "profiles@laptop", state: "idle" }], clients: ["phone~owner@example.com", "panel-desk~owner@example.com"], workers: [] });
    await new Promise((r) => setTimeout(r, 10));
    const r = await call("site@laptop", "list", {});
    expect(JSON.parse(r.content[0].text)).toEqual({
      me: "site@laptop",
      sessions: [
        { callsign: "poe-bot@pc", state: "busy", parent: null, model: null },
        { callsign: "profiles@laptop", state: "idle", parent: null, model: null },
      ],
      clients: ["phone~owner@example.com", "panel-desk~owner@example.com"],
    });
    const fresh = make();
    await fresh.module.start!({} as never);
    const off = await fresh.tools("site@laptop").find((t) => t.name === "list")!.handler({}, {});
    expect(off).toMatchObject({ isError: true });
  });

  it("fleet.send клиенту: кадр message без id и notify модулю push; fleet.answer — запрос answer модулю questions", async () => {
    const notifies: Frame[] = [];
    const answers: Frame[] = [];
    const push = module("host-push", { requests: { notify: (req) => (notifies.push(req), { pushed: [] }) } });
    const questions: Module = { requests: { answer: (req) => void answers.push(req) } };
    const { st, call } = await bench({ extra: [push, module("host-questions", questions)] });
    await st.open("site@laptop");
    await st.open("profiles@laptop");
    expect(await call("site@laptop", "send", { to: "phone~owner@example.com", text: "Готово" })).toEqual({ content: [{ type: "text", text: "отправлено: phone~owner@example.com" }] });
    expect(st.relay.frames("message")).toEqual([{ type: "message", from: "site@laptop", to: "phone~owner@example.com", text: "Готово" }]);
    await until(() => notifies.length === 1);
    expect(notifies[0]).toMatchObject({ v: 1, clients: ["phone~owner@example.com"], frame: { type: "message", from: "site@laptop", notify: { title: "site@laptop", body: "Готово" } } });
    const a = await call("site@laptop", "answer", { to: "profiles@laptop", question: "toolu_01Hq", answers: { "Какую базу мигрировать первой?": "стенд" } });
    expect(a.content[0].text).toBe("принято");
    expect(answers[0]).toMatchObject({ type: "answer", v: 1, callsign: "profiles@laptop", question: "toolu_01Hq", from: "site@laptop", answers: { "Какую базу мигрировать первой?": "стенд" } });
  });

  it("вклад в query(): сервер MCP fleet с семью инструментами, позывной в системном промпте, межсессионная переписка Claude Code выключена", async () => {
    const { st } = await bench();
    await st.open("site@laptop");
    const o = st.query("site@laptop").options as { mcpServers: Record<string, { type: string; name: string }>; systemPrompt: { append?: string }; env: Record<string, string> };
    expect(o.mcpServers.fleet).toMatchObject({ type: "sdk", name: "fleet" });
    expect(o.systemPrompt.append).toContain("Ты во флоте как site@laptop");
    expect(o.env.CLAUDE_CODE_HARBOR_KITE).toBe("0");
    expect(make().tools("x@y").map((t) => t.name)).toEqual(["list", "send", "answer", "open", "history", "update", "remove"]);
  });
});
