// Эталоны входа Worker'а 5041–5046: обёртка entrance с поддельным gate.
import { describe, expect, it, vi } from "vitest";
import type { Frame } from "@switchboard/protocol";
import type { GateApi, VerifyResult } from "../contract.ts";
import { entrance } from "../src/entrance.ts";

const PHONE: VerifyResult = { role: "client", name: "phone", kid: "p3a1", addr: "phone~owner@example.com" };

function gate(r: VerifyResult | "throw"): GateApi & { keys: string[] } {
  const keys: string[] = [];
  return {
    keys,
    async verify(k) {
      keys.push(k);
      if (r === "throw") throw new Error("база gate не ответила");
      return r;
    },
    async revoke() {
      return { error: "unknown_key" as const };
    },
    async revoked() {
      return [];
    },
    async list() {
      return [];
    },
  };
}

const post = (f: Record<string, unknown>) => new Request("https://push.example/", { method: "POST", body: JSON.stringify(f) });

describe("эталоны входа Worker'а", () => {
  it("5041 · POST: кадр с key → gate.verify → frame с from и номером → reply телом; key до frame не доходит", async () => {
    const g = gate(PHONE);
    const seen: Frame[] = [];
    const r = await entrance(post({ type: "push.key", id: "1", v: 1, key: "client.phone.p3a1.secret" }), g, (f) => {
      seen.push(f);
      return [{ type: "reply", id: "1", ok: true, result: { key: "K" }, to: f.from }];
    });
    expect(g.keys).toEqual(["client.phone.p3a1.secret"]);
    expect(seen).toEqual([{ type: "push.key", id: "1", v: 1, from: "phone~owner@example.com", fromKid: "p3a1" }]);
    expect(r.status).toBe(200);
    expect(r.headers.get("access-control-allow-origin")).toBe("*");
    expect(await r.json()).toEqual({ type: "reply", id: "1", ok: true, result: { key: "K" }, to: "phone~owner@example.com" });
  });

  it("5042 · from в кадре POST не берётся: отправитель — адрес пропуска", async () => {
    const seen: Frame[] = [];
    await entrance(post({ type: "push.key", id: "1", v: 1, key: "k", from: "@win", fromKid: "zzzz" }), gate(PHONE), (f) => (seen.push(f), []));
    expect(seen[0]).toMatchObject({ from: "phone~owner@example.com", fromKid: "p3a1" });
  });

  it("5043 · плохой пропуск → bad_key; gate не ответил → gate_unavailable; обработчик не вызван", async () => {
    let calls = 0;
    const h = () => (calls++, []);
    const log: string[] = [];
    const line = (l: string) => void log.push(l);
    expect(await (await entrance(post({ type: "push.key", id: "1", v: 1, key: "x" }), gate({ error: "bad_key" }), h, line)).json()).toMatchObject({ ok: false, error: "bad_key" });
    expect(await (await entrance(post({ type: "push.key", id: "2", v: 1, key: "x" }), gate({ error: "revoked" }), h, line)).json()).toMatchObject({ ok: false, error: "revoked" });
    const down = await entrance(post({ type: "push.key", id: "3", v: 1, key: "x" }), gate("throw"), h, line);
    expect(log[0]).toBe("bad_key push.key");
    expect(log[1]).toBe("revoked push.key");
    expect(log[2]).toContain("gate_unavailable push.key");
    expect(log[2]).toContain("база gate не ответила");
    expect(down.status).toBe(503);
    expect(await down.json()).toMatchObject({ id: "3", ok: false, error: "gate_unavailable" });
    expect(calls).toBe(0);
  });

  it("5045 · кадр без id → принят, тела ответа нет", async () => {
    const seen: Frame[] = [];
    const r = await entrance(post({ type: "ledger.add", v: 1, key: "k", ev: "x", text: "y" }), gate(PHONE), (f) => (seen.push(f), []));
    expect(r.status).toBe(204);
    expect(await r.text()).toBe("");
    expect(seen).toHaveLength(1);
  });

  it("5046 · frame вернул кадр другому → не ушёл, строка relay_only; ответ отправителю — как обычно", async () => {
    const logs: string[] = [];
    const r = await entrance(
      post({ type: "points.put", id: "1", v: 1, key: "k" }),
      gate(PHONE),
      (f) => [
        { type: "points.changed", to: "@win" },
        { type: "reply", id: "1", ok: true, to: f.from },
      ],
      (l) => logs.push(l),
    );
    expect(await r.json()).toMatchObject({ id: "1", ok: true });
    expect(logs).toEqual([expect.stringMatching(/^relay_only points\.changed → "@win"/)]);
  });

  it("не POST — 404; не кадр — bad_frame; обработчик бросил — failed", async () => {
    expect((await entrance(new Request("https://push.example/"), gate(PHONE), () => [])).status).toBe(404);
    const bad = await entrance(new Request("https://push.example/", { method: "POST", body: "не кадр" }), gate(PHONE), () => []);
    expect(await bad.json()).toMatchObject({ ok: false, error: "bad_frame" });
    const log: string[] = [];
    const boom = await entrance(post({ type: "push.key", id: "1", v: 1, key: "k" }), gate(PHONE), () => {
      throw new Error("сбой");
    }, (l) => void log.push(l));
    expect(log[0]).toContain("failed push.key от phone~owner@example.com");
    expect(log[0]).toContain("сбой");
    expect(boom.status).toBe(500);
    expect(await boom.json()).toMatchObject({ ok: false, error: "failed" });
  });

  it("5182 · gate не ответил за предел — gate_unavailable 503, frame не звался", async () => {
    // источник: слово пользователя 2 нояб.: у всех операций лимит; отчёт слепого архитектора 2 нояб.: п. 8 — вызов по привязке без предела
    const late = vi.spyOn(globalThis, "setTimeout").mockImplementation(((cb: () => void) => (queueMicrotask(cb), 0)) as never);
    const hang: GateApi = { ...gate(PHONE), verify: () => new Promise(() => {}) };
    const seen: Frame[] = [];
    const r = await entrance(post({ type: "push.key", id: "1", v: 1, key: "k" }), hang, (f) => (seen.push(f), []), () => {});
    late.mockRestore();
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ type: "reply", id: "1", ok: false, error: "gate_unavailable" });
    expect(seen).toEqual([]);
  });

  it("5183 · номер пропуска отправителя — fromKid; поле kid запроса (keys.revoke {kid}) доходит до frame как есть", async () => {
    // источник: отчёт слепого архитектора 2 нояб.: п. 5 — вход relay через entrance; kid — номер отзываемого пропуска
    const seen: Frame[] = [];
    await entrance(post({ type: "keys.revoke", id: "1", v: 1, key: "k", kid: "zz11", fromKid: "подделка" }), gate(PHONE), (f) => (seen.push(f), []));
    expect(seen[0]).toMatchObject({ kid: "zz11", fromKid: "p3a1", from: "phone~owner@example.com" });
  });
});
