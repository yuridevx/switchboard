// Эталоны и стыки модуля push на стенде Host: поддельные SDK, relay, keeper и часы; Worker push — поддельный участник relay.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stand } from "@switchboard/host";
import type { Frame, Manifest } from "@switchboard/host";
import manifest from "../module.json" with { type: "json" };
import { make } from "../src/push.ts";

const { module, standHost, until } = stand;
type Stand = stand.Stand;

let st: Stand | null = null;
afterEach(async () => {
  await st?.close();
  st = null;
});

const PUSH_WORKER = { name: "push", contract: { "push.key": 1, "push.send": 1, "push.subscribe": 1 } };

/** Стенд: настоящий host-push и модуль-заказчик, через которого зовём notify как модуль машины. */
async function bench() {
  st = await standHost({
    modules: [
      { manifest: manifest as Manifest, module: make() },
      module("host-questions", {}, { uses: { "notify@host-push": 1 } }),
    ],
  });
  return st;
}

function roster(s: Stand, clients: string[], workers: object[] = [PUSH_WORKER]) {
  s.relay.deliver({ type: "roster", machines: [], sessions: [], clients, workers });
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

/** Ответ Worker push на n-й push.send. */
async function answerSend(s: Stand, n: number, r: { ok: true; result?: unknown } | { ok: false; error: string }) {
  const f = await until(() => s.relay.frames("push.send")[n]);
  s.relay.deliver({ type: "reply", id: f.id as string, from: "push", ...r } as Frame);
  return f;
}

describe("эталоны push", () => {
  it("153 · phone нет в roster: ровно один push.send с to push и полями кадра; panel-desk ничего; pushed: [phone]", async () => {
    const s = await bench();
    roster(s, ["panel-desk~owner@example.com"]);
    const p = s.host("host-questions").request("notify", { v: 1, clients: ["phone~owner@example.com", "panel-desk~owner@example.com"], frame: question });
    const f = await answerSend(s, 0, { ok: true, result: { cut: false } });
    expect(await p).toEqual({ ok: true, result: { pushed: ["phone~owner@example.com"] } });
    expect(s.relay.frames("push.send")).toHaveLength(1);
    const { id: _id, ...rest } = f;
    expect(rest).toEqual({ type: "push.send", v: 1, to: ".push", push: { to: "phone~owner@example.com", type: "question", from: "profiles@laptop", notify: question.notify } });
  });

  it("154 · gone: строка в журнале, pushed пуст; следующий notify снова шлёт push.send; на диск ничего", async () => {
    const s = await bench();
    roster(s, []);
    const call = () => s.host("host-questions").request("notify", { v: 1, clients: ["phone~owner@example.com"], frame: question });
    const p1 = call();
    await answerSend(s, 0, { ok: false, error: "gone" });
    expect(await p1).toEqual({ ok: true, result: { pushed: [] } });
    expect(s.journal().filter((l) => l.who === "host-push" && l.word === "gone").map((l) => l.why)).toEqual(["phone~owner@example.com: подписки нет — question без пуша"]);
    const p2 = call();
    await answerSend(s, 1, { ok: false, error: "gone" });
    expect(await p2).toEqual({ ok: true, result: { pushed: [] } });
    expect(s.relay.frames("push.send")).toHaveLength(2);
    expect(readdirSync(join(s.home, "store")).filter((f) => f.startsWith("host-push"))).toEqual([]);
  });

  it("155 · phone на связи: push.send не отправлен, pushed пуст", async () => {
    const s = await bench();
    roster(s, ["phone~owner@example.com"]);
    const r = await s.host("host-questions").request("notify", { v: 1, clients: ["phone~owner@example.com"], frame: question });
    expect(r).toEqual({ ok: true, result: { pushed: [] } });
    expect(s.relay.frames("push.send")).toHaveLength(0);
  });
});

describe("эталоны экосистемы о push", () => {
  it("148 · push.send получает offline: pushed пуст, отказ в журнале Host, повтора нет", async () => {
    const s = await bench();
    roster(s, []);
    const p = s.host("host-questions").request("notify", { v: 1, clients: ["phone~owner@example.com"], frame: question });
    await answerSend(s, 0, { ok: false, error: "offline" });
    expect(await p).toEqual({ ok: true, result: { pushed: [] } });
    expect(s.journal().some((l) => l.who === "host-push" && l.kind === "stop" && l.word === "offline")).toBe(true);
    expect(s.relay.frames("push.send")).toHaveLength(1);
  });

  it("149 · в roster нет участника push: кадр не шлётся, строка «push.send v1 — нет в roster»", async () => {
    const s = await bench();
    roster(s, [], []);
    const r = await s.host("host-questions").request("notify", { v: 1, clients: ["phone~owner@example.com"], frame: question });
    expect(r).toEqual({ ok: true, result: { pushed: [] } });
    expect(s.relay.frames("push.send")).toHaveLength(0);
    expect(s.journal().some((l) => l.who === "host-push" && String(l.why).startsWith("push.send v1 — нет в roster"))).toBe(true);
  });
});

describe("push: юнит", () => {
  it("сессии и машины в clients не пушатся", async () => {
    const s = await bench();
    roster(s, []);
    const r = await s.host("host-questions").request("notify", { v: 1, clients: ["api@pc", "@pc"], frame: question });
    expect(r).toEqual({ ok: true, result: { pushed: [] } });
    expect(s.relay.frames("push.send")).toHaveLength(0);
  });

  it("notify без frame — bad_frame", async () => {
    const s = await bench();
    const r = await s.host("host-questions").request("notify", { v: 1, clients: ["phone~owner@example.com"] });
    expect(r).toEqual({ ok: false, error: "bad_frame" });
  });

  it("roster ещё не пришёл: notify отвечает pushed пуст", async () => {
    const mod = make();
    const logs: unknown[] = [];
    await mod.start!({ log: (r: unknown) => logs.push(r) } as never);
    const r = await mod.requests!.notify({ type: "notify", clients: ["phone~owner@example.com"], frame: question }, {} as never);
    expect(r).toEqual({ pushed: [] });
    expect(logs).toHaveLength(1);
  });
});

describe("push: покрытие плана host-modules", () => {
  it("3012 · одному устройству пуш ушёл, другому подписки нет — pushed только первый", async () => {
    // источник: чьё: код (push.ts:41-51)
    const s = await bench();
    roster(s, []);
    const r = s.host("host-questions").request("notify", { v: 1, clients: ["phone~owner@example.com", "tablet~owner@example.com"], frame: question });
    const a = await until(() => s.relay.frames("push.send")[0]);
    const b = await until(() => s.relay.frames("push.send")[1]);
    const ok = (a.push as { to: string }).to === "phone~owner@example.com" ? a : b;
    const gone = ok === a ? b : a;
    s.relay.deliver({ type: "reply", id: ok.id as string, from: "push", ok: true } as Frame);
    s.relay.deliver({ type: "reply", id: gone.id as string, from: "push", ok: false, error: "gone" } as Frame);
    expect(await r).toEqual({ ok: true, result: { pushed: ["phone~owner@example.com"] } });
    const line = s.journal().find((l) => l.ev === "push.send" && l.word === "gone");
    expect(line).toBeDefined();
    expect(line!.kind).not.toBe("stop");
  });

  it("3013 · адрес человека ~email — пуша нет (только устройствам)", async () => {
    // источник: чьё: код (push.ts:33-34 «пуш — только устройствам людей»)
    const s = await bench();
    roster(s, []);
    const r = await s.host("host-questions").request("notify", { v: 1, clients: ["~owner@example.com"], frame: question });
    expect(r).toEqual({ ok: true, result: { pushed: [] } });
    expect(s.relay.frames("push.send")).toHaveLength(0);
  });
});
