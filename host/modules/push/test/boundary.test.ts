// Леса границы «уведомление доходит до человека», сторона Host. Снаружи: relay и Worker push — стенд Host; заказчик — поддельный модуль.
// Вход — запрос notify; исход — ответ, кадр push.send, журнал, хранилище. Номер — эталон-источник; без пометки — чьё: код.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stand } from "@switchboard/host";
import type { Frame, Manifest } from "@switchboard/host";
import manifest from "../module.json" with { type: "json" };
import push from "../contract.ts";

const { module, standHost, until } = stand;
type Stand = stand.Stand;

let st: Stand | null = null;
afterEach(async () => {
  await st?.close();
  st = null;
});

const PHONE = "phone~owner@example.com";
const PULT = "pult~owner@example.com";
const OWNER = "~owner@example.com";
const WORKER = { name: "push", contract: { "push.key": 1, "push.send": 1, "push.subscribe": 1 } };

/** Настоящий модуль и заказчик; clients — кто на связи по roster. */
async function bench(clients: string[], workers: object[] = [WORKER]) {
  st = await standHost({ modules: [{ manifest: manifest as Manifest, module: push }, module("host-asker", {}, { uses: { "notify@host-push": 1 } })] });
  st.relay.deliver({ type: "roster", machines: [], sessions: [], clients, workers });
  return st;
}

const question = {
  type: "question",
  from: "profiles@laptop",
  notify: {
    title: "profiles@laptop спрашивает",
    body: "Какую базу мигрировать первой?",
    actions: [{ title: "прод", frame: { type: "answer" } }, { title: "стенд", frame: { type: "answer" } }],
    tag: "toolu_01Hq",
  },
};

const notify = (s: Stand, clients: unknown, frame: unknown = question) => s.host("host-asker").request("notify", { v: 1, clients, frame });
const sends = (s: Stand) => s.relay.frames("push.send");
const reply = (s: Stand, f: Frame, r: { ok: true; result?: unknown } | { ok: false; error: string }) => s.relay.deliver({ type: "reply", id: f.id as string, from: "push", ...r } as Frame);
const lines = (s: Stand) => s.journal().filter((l) => l.who === "host-push");

describe("кому пуш", () => {
  it("153 · устройства нет на связи: один push.send с полями кадра; устройству на связи пуша нет", async () => {
    const s = await bench([PULT]);
    const p = notify(s, [PHONE, PULT]);
    const f = await until(() => sends(s)[0]);
    reply(s, f, { ok: true });
    expect(await p).toEqual({ ok: true });
    expect(sends(s)).toHaveLength(1);
    const { id: _id, ...rest } = f;
    expect(rest).toEqual({ type: "push.send", v: 1, to: ".push", push: { to: PHONE, type: "question", from: "profiles@laptop", notify: question.notify } });
    // пуш ушёл — строки «без пуша» нет: её ищет живой флоу scripts/flow-more.ts
    expect(lines(s).filter((l) => /без пуша/.test(String(l.why)))).toEqual([]);
  });

  it("roster ещё не приходил: пуша нет, строка в журнале", async () => {
    // на стенде первый roster приходит при связи: ядро без него — поддельное
    const logs: Array<{ ev?: string; why?: string }> = [];
    await push.start!({ log: (r: { ev?: string; why?: string }) => logs.push(r), roster: () => null } as never);
    expect(await push.requests!.notify({ type: "notify", clients: [PHONE], frame: question }, {} as never)).toBeUndefined();
    expect(logs.map((l) => [l.ev, l.why])).toEqual([["notify", `question → ${PHONE}: roster ещё не пришёл — пуша нет`]]);
  });

  it("3013 · человек ~email: один push.send со skip — его устройства на связи, чужое не в skip", async () => {
    const s = await bench([PULT, "phone~anna@example.com"]);
    const p = notify(s, [OWNER]);
    const f = await until(() => sends(s)[0]);
    reply(s, f, { ok: true });
    expect(f.push).toEqual({ to: OWNER, skip: [PULT], type: "question", from: "profiles@laptop", notify: question.notify });
    expect(await p).toEqual({ ok: true });
    expect(sends(s)).toHaveLength(1);
  });
});

describe("исход пуша", () => {
  it("154 · подписки нет: строка gone без остановки; следующий notify снова шлёт; на диск ничего", async () => {
    const s = await bench([]);
    for (const n of [0, 1]) {
      const p = notify(s, [PHONE]);
      reply(s, await until(() => sends(s)[n]), { ok: false, error: "gone" });
      expect(await p).toEqual({ ok: true });
    }
    const gone = lines(s).filter((l) => l.word === "gone");
    expect(gone.map((l) => [l.ev, l.why])).toEqual(Array(2).fill(["push.send", `${PHONE}: подписки нет — question без пуша`]));
    expect(gone.some((l) => l.kind === "stop")).toBe(false);
    expect(readdirSync(join(s.home, "store")).filter((f) => f.startsWith("host-push"))).toEqual([]);
  });

  it("148 · Worker ответил offline: строка stop со словом, повтора нет", async () => {
    const s = await bench([]);
    const p = notify(s, [PHONE]);
    reply(s, await until(() => sends(s)[0]), { ok: false, error: "offline" });
    expect(await p).toEqual({ ok: true });
    expect(lines(s).filter((l) => l.kind === "stop").map((l) => [l.ev, l.word, l.why])).toEqual([["push.send", "offline", `push.send ${PHONE}: offline — question без пуша`]]);
    expect(sends(s)).toHaveLength(1);
  });
});

describe("вход", () => {
  it("notify не по форме, нет frame: bad_frame со словами", async () => {
    const s = await bench([]);
    const r = await s.host("host-asker").request("notify", { v: 1, clients: [PHONE] });
    expect(r).toMatchObject({ ok: false, error: "bad_frame" });
    expect(sends(s)).toHaveLength(0);
  });
});
