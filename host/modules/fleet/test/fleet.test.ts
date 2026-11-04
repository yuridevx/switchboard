// Эталоны и стыки модуля fleet на стенде Host: поддельные SDK, relay, keeper и часы.
// Инструменты MCP зовутся как их зовёт SDK — обработчиком tool() сервера сессии.
import { afterEach, describe, expect, it } from "vitest";
import { stand } from "@switchboard/host";
import type { Frame, Manifest } from "@switchboard/host";
import manifest from "../module.json" with { type: "json" };
import { make } from "../src/fleet.ts";
import { make as makeChat, wrap } from "../../chat/contract.ts";
import chatManifest from "../../chat/module.json" with { type: "json" };
import pushManifest from "../../push/module.json" with { type: "json" };
import { make as makePush } from "../../push/src/push.ts";

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
  const st = await standHost({ machine: o.machine, holders: o.holders, home: o.home, modules: [{ manifest: chatManifest as Manifest, module: makeChat() }, { manifest: manifest as Manifest, module: f.module }, ...(o.extra ?? [])] });
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

});

describe("fleet: инструменты и вклад", () => {
  it("fleet.list до первого roster — ошибка инструмента со словом disconnected", async () => {
    // выжимку roster закрепляет эталон 302; здесь — только ветка «roster ещё не пришёл»
    const fresh = make();
    await fresh.module.start!({ roster: () => null } as never);
    const off = await fresh.tools("site@laptop").find((t) => t.name === "list")!.handler({}, {});
    expect(off).toEqual({ content: [{ type: "text", text: "Нет связи с relay (disconnected): список сессий неизвестен" }], isError: true });
  });

  it("fleet.send человеку: кадр message без id; телефона нет на связи — пуш запросом push.send с заголовком отправителя", async () => {
    // источник: устав — «достают до телефона»; принятый дизайн — «send — сессии или человеку»; текст ответа — чьё: код
    const { st, call } = await bench({ extra: [{ manifest: pushManifest as Manifest, module: makePush() }] });
    st.relay.deliver({ type: "roster", machines: [], sessions: [], clients: [] });
    await st.open("site@laptop");
    expect(await call("site@laptop", "send", { to: "phone~owner@example.com", text: "Готово" })).toEqual({ content: [{ type: "text", text: "отправлено: phone~owner@example.com" }] });
    expect(st.relay.frames("message")).toEqual([{ type: "message", v: 1, from: "site@laptop", to: "phone~owner@example.com", text: "Готово" }]);
    const push = await until(() => st.relay.frames("push.send")[0]);
    expect(push).toMatchObject({ v: 1, to: ".push", push: { to: "phone~owner@example.com", type: "message", from: "site@laptop", notify: { title: "site@laptop", body: "Готово" } } });
  });

  it("fleet.answer на вопрос сессии другой машины — запрос answer через relay от отвечающей сессии; модели — «принято»", async () => {
    // источник: устав — AskUserQuestion получает тот, кто дал задачу; первый ответ выигрывает
    const { st, call } = await bench();
    await st.open("site@laptop");
    const pending = call("site@laptop", "answer", { to: "profiles@pc", question: "toolu_01Hq", answers: { "Какую базу мигрировать первой?": "стенд" } });
    const a = await until(() => st.relay.frames("answer")[0]);
    expect(a).toMatchObject({ type: "answer", v: 1, callsign: "profiles@pc", question: "toolu_01Hq", from: "site@laptop", answers: { "Какую базу мигрировать первой?": "стенд" } });
    st.relay.deliver({ type: "reply", id: a.id as string, ok: true } as Frame);
    expect((await pending).content[0].text).toBe("принято");
  });

  it("335 · fleet.send: связи с relay нет — модели «Доставка не подтверждена: нет связи с relay (disconnected)»", async () => {
    // источник: устав — соединение с Worker-модулем оборвалось — клиенты переподключаются; ошибки словами; текст — чьё: код
    const { st, call } = await bench();
    await st.open("site@laptop");
    st.relay.drop();
    await until(() => st.kernel.relay?.state !== "open");
    const r = await call("site@laptop", "send", { to: "wiki@pc", text: "x" });
    expect(r).toEqual({ content: [{ type: "text", text: "Доставка не подтверждена: нет связи с relay (disconnected)" }], isError: true });
  });

  it("вклад в query(): сервер MCP fleet с семью инструментами, позывной в системном промпте, межсессионная переписка Claude Code выключена", async () => {
    const { st } = await bench();
    await st.open("site@laptop");
    const o = st.query("site@laptop").options as { mcpServers: Record<string, { type: string; name: string }>; systemPrompt: { append?: string }; env: Record<string, string> };
    expect(o.mcpServers.fleet).toMatchObject({ type: "sdk", name: "fleet" });
    expect(o.systemPrompt.append).toContain("Ты во флоте как site@laptop");
    expect(o.env.CLAUDE_CODE_HARBOR_KITE).toBe("0");
    expect(make().tools("x@y").map((t) => t.name)).toEqual(["list", "send", "answer", "open", "history", "update", "label", "remove"]);
  });
});

describe("fleet: покрытие плана host-modules", () => {
  it("3024 · fleet.send человеку ~email — кадр message его адресу, «отправлено»; один push.send его адресу (пуш всем его устройствам не на связи)", async () => {
    // источник: чьё: код (fleet.ts:75, :82-86); слово пользователя 2 нояб. «пушить всем»
    const { st, call } = await bench({ extra: [{ manifest: pushManifest as Manifest, module: makePush() }] });
    st.relay.deliver({ type: "roster", machines: [], sessions: [], clients: [] });
    await st.open("site@laptop");
    expect(await call("site@laptop", "send", { to: "~owner@example.com", text: "Готово" })).toEqual({ content: [{ type: "text", text: "отправлено: ~owner@example.com" }] });
    expect(st.relay.frames("message")).toEqual([{ type: "message", v: 1, from: "site@laptop", to: "~owner@example.com", text: "Готово" }]);
    await new Promise((r) => setTimeout(r, 20));
    expect(st.relay.frames("push.send").map((f) => (f.push as { to: string; skip?: unknown }))).toEqual([expect.objectContaining({ to: "~owner@example.com" })]);
    expect((st.relay.frames("push.send")[0].push as { skip?: unknown }).skip).toBeUndefined();
  });
});
