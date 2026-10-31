// Эталоны gate 111–115, 118 и юнит-тесты ключа — в workerd, с секретом и REVOKED теста.
import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GateApi } from "../contract.ts";
import { parseKey, sign, verifyKey } from "../src/key.ts";
import config from "../wrangler.jsonc?raw";

const SECRET = "test-secret";
const gate = (exports as unknown as { Gate: GateApi }).Gate;
let logs: string[] = [];

beforeEach(() => {
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
});
afterEach(() => vi.restoreAllMocks());

describe("эталоны gate", () => {
  it("111 · верный ключ host.laptop.k7f3 — роль, имя, номер; в журнале ok", async () => {
    const key = await sign(SECRET, "host", "laptop", "k7f3");
    expect(await gate.verify(key)).toEqual({ role: "host", name: "laptop", kid: "k7f3" });
    expect(logs).toContain("ok host.laptop.k7f3");
  });

  it("112 · ключ, подписанный другим секретом, — bad_key; в журнале имя ключа и причина, подписи нет", async () => {
    const key = await sign("другой-секрет", "host", "laptop", "k7f3");
    expect(await gate.verify(key)).toEqual({ error: "bad_key" });
    expect(logs).toEqual(["bad_key host.laptop.k7f3 · подпись не сошлась"]);
    expect(logs.join("\n")).not.toContain(key.split(".")[3]);
  });

  it("113 · отозванный client.phone.k2a9 — revoked; новый ключ k8e1 тем же секретом проходит", async () => {
    expect(await gate.verify(await sign(SECRET, "client", "phone", "k2a9"))).toEqual({ error: "revoked" });
    expect(await gate.verify(await sign(SECRET, "client", "phone", "k8e1"))).toEqual({ role: "client", name: "phone", kid: "k8e1" });
    expect(logs).toEqual(["revoked client.phone.k2a9", "ok client.phone.k8e1"]);
  });

  it("114 · ключ не того вида — bad_key без исключения, HMAC не считался", async () => {
    const imp = vi.spyOn(crypto.subtle, "importKey");
    expect(await gate.verify("laptop-key")).toEqual({ error: "bad_key" });
    expect(await gate.verify("admin.laptop.k7f3.Jx9w")).toEqual({ error: "bad_key" });
    expect(await gate.verify(undefined as unknown as string)).toEqual({ error: "bad_key" });
    expect(imp).not.toHaveBeenCalled();
  });

  it("115 · конфиг выпуска: workers_dev и preview_urls выключены, маршрутов нет", () => {
    const c = JSON.parse(config.replace(/^\s*\/\/.*$/gm, ""));
    expect(c.name).toBe("switchboard-gate");
    expect(c.workers_dev).toBe(false);
    expect(c.preview_urls).toBe(false);
    expect(c.routes ?? c.route).toBeUndefined();
    expect(c.vars?.FLEET_SECRET).toBeUndefined(); // секрет — только через wrangler secret put
  });

  it("118 · нет FLEET_SECRET — исключение с причиной, в журнале «FLEET_SECRET не задан»", async () => {
    const key = await sign(SECRET, "client", "phone", "k8e1");
    await expect(verifyKey(key, undefined, [], (l) => logs.push(l))).rejects.toThrow("FLEET_SECRET не задан");
    expect(logs).toContain("error FLEET_SECRET не задан");
  });
});

describe("ключ", () => {
  it("вид ключа: четыре части, роль host или client, знаки A-Z a-z 0-9 _ -", () => {
    expect(parseKey("host.laptop.k7f3.sig")).toMatchObject({ role: "host", name: "laptop", kid: "k7f3", id: "host.laptop.k7f3" });
    expect(parseKey("client.panel-desk.k3f1.a_b-c")).not.toBeNull();
    for (const k of ["host.laptop.k7f3", "host.lap.top.k7f3.sig", "host..k7f3.sig", "host.lap@top.k7f3.sig", "guest.x.y.z", 42]) {
      expect(parseKey(k)).toBeNull();
    }
  });

  it("подпись привязана к role.name.kid: та же подпись под другим именем или номером — bad_key", async () => {
    const sig = (await sign(SECRET, "client", "phone", "k8e1")).split(".")[3];
    expect(await gate.verify(`host.phone.k8e1.${sig}`)).toEqual({ error: "bad_key" });
    expect(await gate.verify(`client.phone.k8e2.${sig}`)).toEqual({ error: "bad_key" });
    expect(await gate.verify(`client.phone.k8e1.QUJD`)).toEqual({ error: "bad_key" });
  });

  it("sign отказывает в недопустимом имени", async () => {
    await expect(sign(SECRET, "host", "lap.top", "k7f3")).rejects.toThrow();
  });
});
