// Леса границы «пропуск участника», среда Worker: пропуска над базой D1 стенда, общий вход Worker'ов, стенд gate для соседей.
// Вход — POST кадра, методы входа Gate, entrance и gateStand из контракта. Исход — ответ, строка базы, строка журнала.
// Номер — эталон-источник; свойства без пометки — чьё: код. Формат пропуска и схема базы заморожены: пропуска уже выданы на машины.
import { exports, env as rawEnv } from "cloudflare:workers";
import { applyD1Migrations, createExecutionContext, type D1Migration } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_FRAME, type Frame } from "@switchboard/protocol";
import { entrance, type GateApi, type Pass, type VerifyResult } from "../contract.ts";
import worker, { Gate } from "../src/index.ts";

type Stand = GateApi & { setHosts(names: string[]): Promise<void> };
type TestEnv = { DB: D1Database; PROD: D1Database; TEST_MIGRATIONS: D1Migration[]; TEST_SEED: { sql: string; invite: string }; STAND: Stand };
type Reply = { type: string; id: string; ok: boolean; result?: any; error?: string };

const env = rawEnv as unknown as TestEnv;
const gate = (exports as unknown as { Gate: GateApi }).Gate;
let logs: string[] = [];
let n = 0;

const send = (body: string, e: { DB: D1Database } = env) => worker.fetch(new Request("https://gate/", { method: "POST", body }), e as never);
/** POST по адресу gate: кадр → reply. */
async function post(f: Record<string, unknown>, e: { DB: D1Database } = env): Promise<Reply> {
  return (await send(JSON.stringify({ id: String(++n), v: 1, ...f }), e)).json();
}

const sha256 = async (t: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t)))].map((b) => b.toString(16).padStart(2, "0")).join("");
const SIG = "S".repeat(43);

/** Принятый пропуск прямо строкой базы: формат строки — контракт, настоящие пропуска лежат в нём. */
async function passRow(role: "host" | "client", name: string, kid: string, person: string | null = null, at = 1): Promise<string> {
  await env.DB.prepare("INSERT INTO passes (id, role, name, person, state, hash, by, at) VALUES (?, ?, ?, ?, 'ok', ?, 'seed', ?)").bind(kid, role, name, person, await sha256(SIG), at).run();
  return `${role}.${name}.${kid}.${SIG}`;
}
const agent = () => passRow("host", `agent${++n}`, `a${String(n).padStart(3, "0")}`.slice(0, 4));
const invited = async (f: Record<string, unknown>, by?: string) => (await post({ type: "keys.invite", key: by ?? (await agent()), ...f })).result as { kid: string; invite: string; addr: string };
const redeemed = async (f: Record<string, unknown>) => {
  const inv = await invited(f);
  return { ...inv, key: (await post({ type: "gate.redeem", invite: inv.invite })).result.key as string };
};
const row = (id: string) => env.DB.prepare("SELECT * FROM passes WHERE id = ?").bind(id).first<Record<string, unknown>>();
const rows = async () => (await env.DB.prepare("SELECT * FROM passes").all<Record<string, unknown>>()).results;

beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await applyD1Migrations(env.PROD, env.TEST_MIGRATIONS);
  await env.DB.exec("DELETE FROM passes");
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
});
afterEach(() => vi.restoreAllMocks());

describe("приглашение и приём", () => {
  it("5001 · invite → строка «ждёт приёма» с хэшем приглашения; redeem → пропуск, новый хэш, «принят»; второй redeem → bad_invite; журнал без секретов", async () => {
    const by = await agent();
    const inv = await post({ type: "keys.invite", key: by, role: "client", name: "phone", person: "owner@example.com" });
    expect(inv).toMatchObject({ type: "reply", ok: true });
    expect(Object.keys(inv.result).sort()).toEqual(["addr", "invite", "kid"]);
    expect(inv.result.invite).toMatch(/^[a-z0-9]{4}\.[A-Za-z0-9_-]{43}$/);
    const [kid, code] = inv.result.invite.split(".");
    expect(inv.result.kid).toBe(kid);
    expect(kid).toMatch(/^[a-z0-9]{4}$/);
    const waiting = (await row(kid))!;
    expect(waiting).toMatchObject({ role: "client", name: "phone", person: "owner@example.com", state: "wait", hash: await sha256(code), by: expect.stringMatching(/^@agent/) });
    expect(logs).toContainEqual(`invite ${kid} phone~owner@example.com · выдал ${waiting.by}`);

    const r1 = await post({ type: "gate.redeem", invite: inv.result.invite });
    expect(Object.keys(r1.result)).toEqual(["key"]);
    expect(r1.result.key).toMatch(new RegExp(`^client\\.phone\\.${kid}\\.[A-Za-z0-9_-]{43}$`));
    const taken = (await row(kid))!;
    expect(taken.state).toBe("ok");
    expect(taken.hash).toBe(await sha256(r1.result.key.split(".")[3]));
    expect(logs).toContainEqual(`redeem client.phone.${kid} · принят`);
    expect(logs.join("\n")).not.toContain(r1.result.key.split(".")[3]);
    expect(logs.join("\n")).not.toContain(code);

    expect(await post({ type: "gate.redeem", invite: inv.result.invite })).toMatchObject({ ok: false, error: "bad_invite" });
    expect(logs).toContainEqual(`bad_invite приглашения ${kid} нет, оно принято или отозвано`);
    expect(await gate.verify(r1.result.key)).toMatchObject({ addr: "phone~owner@example.com" });
  });

  it("5002 · revoke строки «ждёт приёма» → redeem получает bad_invite", async () => {
    const inv = await invited({ role: "host", name: "laptop" });
    expect(await gate.revoke(inv.kid)).toEqual({ addr: "@laptop" });
    expect(await post({ type: "gate.redeem", invite: inv.invite })).toMatchObject({ ok: false, error: "bad_invite" });
  });

  it.each([
    ["не того вида", "nope", "приглашение не того вида: номер.секрет"],
    ["не строка", 42, "приглашение не того вида: номер.секрет"],
    ["секрет не той длины", `abcd.${"A".repeat(42)}`, "приглашение не того вида: номер.секрет"],
    ["номер с заглавной", `ABCD.${"A".repeat(43)}`, "приглашение не того вида: номер.секрет"],
    ["номера нет", `zzzz.${"A".repeat(43)}`, "приглашения zzzz нет, оно принято или отозвано"],
  ])("gate.redeem без пропуска: %s → bad_invite, причина в журнале", async (_n, invite, why) => {
    expect(await post({ type: "gate.redeem", invite })).toMatchObject({ ok: false, error: "bad_invite" });
    expect(logs).toEqual([`bad_invite ${why}`]);
  });

  it("gate.redeem: секрет приглашения не тот — bad_invite, строка ждёт дальше", async () => {
    const inv = await invited({ role: "host", name: "laptop" });
    expect(await post({ type: "gate.redeem", invite: `${inv.kid}.${"A".repeat(43)}` })).toMatchObject({ ok: false, error: "bad_invite" });
    expect(logs).toContainEqual(`bad_invite приглашения ${inv.kid} нет, оно принято или отозвано`);
    expect((await row(inv.kid))!.state).toBe("wait");
    expect(await post({ type: "gate.redeem", invite: inv.invite })).toMatchObject({ ok: true });
  });

  it("одно приглашение, два приёма разом → один пропуск, второй bad_invite", async () => {
    const inv = await invited({ role: "host", name: "laptop" });
    const both = await Promise.all([post({ type: "gate.redeem", invite: inv.invite }), post({ type: "gate.redeem", invite: inv.invite })]);
    expect(both.map((r) => r.ok).sort()).toEqual([false, true]);
    expect(both.find((r) => !r.ok)!.error).toBe("bad_invite");
    expect(await gate.verify(both.find((r) => r.ok)!.result.key)).toMatchObject({ addr: "@laptop" });
  });

  it("at в миллисекундах: время выдачи, с приёмом — время приёма; by остаётся; их показывает список", async () => {
    const from = Date.now();
    const inv = await invited({ role: "host", name: "laptop" });
    const waiting = (await row(inv.kid))!;
    expect(waiting.at).toBeGreaterThanOrEqual(from);
    expect(waiting.at).toBeLessThanOrEqual(Date.now());
    await new Promise((r) => setTimeout(r, 2));
    await post({ type: "gate.redeem", invite: inv.invite });
    const taken = (await row(inv.kid))!;
    expect(taken.by).toBe(waiting.by);
    expect(taken.at).toBeGreaterThan(waiting.at as number);
  });

  it("5013 · инструкция настоящего seed → в базе строка «ждёт приёма»; redeem даёт пропуск, который проходит verify", async () => {
    const s = env.TEST_SEED;
    await env.DB.exec(s.sql);
    const [kid] = s.invite.split(".");
    expect(await row(kid)).toMatchObject({ role: "host", name: "first", person: null, state: "wait", by: "seed" });
    const { key } = (await post({ type: "gate.redeem", invite: s.invite })).result;
    expect(key).toMatch(new RegExp(`^host\\.first\\.${kid}\\.`));
    expect(await gate.verify(key)).toEqual({ role: "host", name: "first", kid, addr: "@first" });
  });

  it("5007 · адрес вычисляет база: устройство → phone~почта; машина → @laptop, person пуст", async () => {
    const by = await agent();
    expect((await invited({ role: "client", name: "phone", person: "owner@example.com" }, by)).addr).toBe("phone~owner@example.com");
    const m = await invited({ role: "host", name: "laptop" }, by);
    expect(m.addr).toBe("@laptop");
    expect((await row(m.kid))!.person).toBeNull();
  });

  it("5008 · адрес с живым пропуском → name_taken, причина в журнале; другой человек — другой адрес; после отзыва проходит", async () => {
    const by = await agent();
    const who = (await gate.verify(by)) as { addr: string };
    const a = await invited({ role: "client", name: "phone", person: "owner@example.com" }, by);
    expect(await post({ type: "keys.invite", key: by, role: "client", name: "phone", person: "owner@example.com" })).toMatchObject({ ok: false, error: "name_taken" });
    expect(logs).toContainEqual(`name_taken keys.invite от ${who.addr} · у адреса phone~owner@example.com есть живой пропуск`);
    expect((await post({ type: "keys.invite", key: by, role: "client", name: "phone", person: "other@example.com" })).ok).toBe(true);
    await post({ type: "keys.invite", key: by, role: "host", name: "laptop" });
    expect(await post({ type: "keys.invite", key: by, role: "host", name: "laptop" })).toMatchObject({ ok: false, error: "name_taken" });
    expect(logs).toContainEqual(`name_taken keys.invite от ${who.addr} · у адреса @laptop есть живой пропуск`);
    await gate.revoke(a.kid);
    expect((await post({ type: "keys.invite", key: by, role: "client", name: "phone", person: "owner@example.com" })).ok).toBe(true);
  });

  it("номер занят — приглашение получает другой номер; три занятых подряд — gate_unavailable, причина в журнале", async () => {
    const by = await agent();
    await passRow("host", "busy", "aaaa");
    const real = crypto.getRandomValues.bind(crypto);
    let script = [0, 1];
    vi.spyOn(crypto, "getRandomValues").mockImplementation(((a: Uint8Array) => {
      if (a.length !== 4) return real(a);
      return a.fill(script.shift() ?? 0);
    }) as never);
    const inv = await post({ type: "keys.invite", key: by, role: "host", name: "laptop" });
    expect(inv.result.kid).toBe("bbbb");
    script = [0, 0, 0];
    const r = await post({ type: "keys.invite", key: by, role: "host", name: "next" });
    expect(r).toMatchObject({ ok: false, error: "gate_unavailable" });
    expect(logs).toContainEqual("gate_unavailable три номера подряд заняты");
  });

  it.each([
    ["role не та", { role: "admin", name: "x" }, "role — host или client"],
    ["имя с точкой", { role: "host", name: "lap.top" }, "name — A-Z a-z 0-9 _ -"],
    ["имя не строка", { role: "host", name: 7 }, "name — A-Z a-z 0-9 _ -"],
    ["client без почты", { role: "client", name: "phone" }, "person — почта человека за устройством или программой"],
    ["почта без @", { role: "client", name: "phone", person: "owner" }, "person — почта человека за устройством или программой"],
    ["почта с ~", { role: "client", name: "phone", person: "o~w@x" }, "person — почта человека за устройством или программой"],
    ["у машины почта", { role: "host", name: "laptop", person: "a@b" }, "у машины person нет"],
  ])("keys.invite: %s → bad_request, причина в журнале, строки нет", async (_n, fields, why) => {
    const by = await agent();
    const who = (await gate.verify(by)) as { addr: string };
    const before = (await rows()).length;
    expect(await post({ type: "keys.invite", key: by, ...fields })).toMatchObject({ ok: false, error: "bad_request" });
    expect(logs).toContainEqual(`bad_request keys.invite от ${who.addr} · ${why}`);
    expect((await rows()).length).toBe(before);
  });
});

describe("проверка пропуска", () => {
  it("5003 · verify: строка есть, хэш сошёлся → роль, имя, номер и адрес; строка не меняется; задержка — в журнале", async () => {
    const { key, kid } = await redeemed({ role: "host", name: "laptop" });
    const before = await rows();
    expect(await gate.verify(key)).toEqual({ role: "host", name: "laptop", kid, addr: "@laptop" });
    expect(await rows()).toEqual(before);
    expect(logs).toContainEqual(expect.stringMatching(new RegExp(`^ok host\\.laptop\\.${kid} → @laptop · \\d+ мс$`)));
  });

  it("5005 · verify отдаёт правду строки: адрес клиента — с почтой; роль или имя в пропуске не как в строке → bad_key", async () => {
    const { key, kid } = await redeemed({ role: "client", name: "phone", person: "owner@example.com" });
    const sec = key.split(".")[3];
    expect(await gate.verify(key)).toEqual({ role: "client", name: "phone", kid, addr: "phone~owner@example.com" });
    for (const k of [`host.phone.${kid}.${sec}`, `client.laptop.${kid}.${sec}`]) expect(await gate.verify(k)).toEqual({ error: "bad_key" });
  });

  it("5004 · verify: bad_key и причина в журнале, база не меняется: секрет не тот, номера нет, пропуск не принят, отозван", async () => {
    const { key, kid } = await redeemed({ role: "host", name: "laptop" });
    const wait = await invited({ role: "host", name: "wait" });
    const cases: Array<[string, string]> = [
      [`host.laptop.${kid}.${"A".repeat(43)}`, `^bad_key host\\.laptop\\.${kid} · не сошлись секрет, роль или имя · \\d+ мс$`],
      // 5201: старый ключ подписью — номера в базе нет
      ["host.laptop.k7f3.c2lnbmF0dXJl", "^bad_key host\\.laptop\\.k7f3 · номера нет в базе · \\d+ мс$"],
      [`host.wait.${wait.kid}.${wait.invite.split(".")[1]}`, `^bad_key host\\.wait\\.${wait.kid} · пропуск не принят · \\d+ мс$`],
    ];
    for (const [k, line] of cases) {
      logs = [];
      expect(await gate.verify(k)).toEqual({ error: "bad_key" });
      expect(logs).toEqual([expect.stringMatching(new RegExp(line))]);
    }
    await gate.revoke(kid);
    logs = [];
    expect(await gate.verify(key)).toEqual({ error: "bad_key" });
    expect(logs).toEqual([expect.stringMatching(new RegExp(`^bad_key host\\.laptop\\.${kid} · номера нет в базе · \\d+ мс$`))]);
  });

  it.each([
    ["без частей", "laptop-key"],
    ["роль не та", "admin.laptop.k7f3.Jx9w"],
    ["три части", "host.laptop.k7f3"],
    ["пустая часть", "host..k7f3.sig"],
    ["недопустимый знак", "host.lap$top.k7f3.sig"],
    ["не строка", 42],
    ["нет", undefined],
  ])("114 · пропуск не того вида: %s — bad_key без исключения, причина в журнале", async (_n, k) => {
    expect(await gate.verify(k as string)).toEqual({ error: "bad_key" });
    expect(logs).toEqual(["bad_key пропуск не того вида: нужно role.name.kid.secret, роль host или client"]);
  });

  it("5006 · в базе нет секретов: после invite и redeem — только хэши", async () => {
    const { key, invite } = await redeemed({ role: "client", name: "phone", person: "owner@example.com" });
    const dump = JSON.stringify(await rows());
    expect(dump).not.toContain(invite.split(".")[1]);
    expect(dump).not.toContain(key.split(".")[3]);
    expect((await rows()).every((r) => /^[0-9a-f]{64}$/.test(String(r.hash)))).toBe(true);
  });

  it("5009 · пропуск тестового флота в базе прода → bad_key", async () => {
    const { key } = await redeemed({ role: "host", name: "laptop" });
    expect(await post({ type: "keys.list", key })).toMatchObject({ ok: true });
    expect(await post({ type: "keys.list", key }, { DB: env.PROD })).toMatchObject({ ok: false, error: "bad_key" });
  });
});

describe("отзыв", () => {
  it("7305 · отзыв удаляет строку: номера нет, второй отзыв — unknown_key, адрес свободен; журнал", async () => {
    const by = await agent();
    const a = await invited({ role: "host", name: "laptop" }, by);
    expect(await gate.revoke(a.kid)).toEqual({ addr: "@laptop" });
    expect(logs).toContainEqual(`revoked ${a.kid} @laptop · строка удалена`);
    expect(await row(a.kid)).toBeNull();
    expect(await gate.revoke(a.kid)).toEqual({ error: "unknown_key" });
    expect(logs).toContainEqual(`unknown_key ${a.kid} · отзыв`);
    expect(await post({ type: "keys.invite", key: by, role: "host", name: "laptop" })).toMatchObject({ ok: true });
  });

  it("5011 · revoked(номера) → которых нет в базе; номер — kid или role.name.kid; живые не попадают; пустой список", async () => {
    const by = await agent();
    const a = await invited({ role: "host", name: "a" }, by);
    const b = await invited({ role: "host", name: "b" }, by);
    await gate.revoke(a.kid);
    expect(await gate.revoked([a.kid, b.kid, `host.b.${b.kid}`, "client.phone.zzzz", `host.a.${a.kid}`])).toEqual([a.kid, "client.phone.zzzz", `host.a.${a.kid}`]);
    expect(await gate.revoked([])).toEqual([]);
  });

  it("revoked: 150 номеров за раз — без предела числа переменных базы; живой среди них не попадает", async () => {
    const live = await invited({ role: "host", name: "alive" });
    const ids = [...Array.from({ length: 149 }, (_, i) => `z${i}`), live.kid];
    expect(await gate.revoked(ids)).toEqual(ids.slice(0, 149));
  });
});

describe("список пропусков", () => {
  it("5012 · keys.list с ролью → только принятые этой роли; без роли — все по времени, поля строки без хэша; привязка list — то же", async () => {
    const by = await agent();
    await invited({ role: "host", name: "wait-machine" }, by);
    const gone = await redeemed({ role: "host", name: "gone" });
    await gate.revoke(gone.kid);
    await passRow("client", "phone", "cli1", "owner@example.com", 2);
    await passRow("host", "older", "old1", null, 0);
    const hosts: Pass[] = (await post({ type: "keys.list", key: by, role: "host" })).result.passes;
    expect(hosts.map((p) => p.name)).toEqual(["older", expect.stringMatching(/^agent/), expect.stringMatching(/^agent/)]);
    expect(hosts.every((p) => p.state === "ok" && p.role === "host")).toBe(true);
    const all: Pass[] = (await post({ type: "keys.list", key: by })).result.passes;
    expect(all.map((p) => p.state)).toContain("wait");
    expect(all.map((p) => p.at)).toEqual([...all.map((p) => p.at)].sort((x, y) => x - y));
    expect(Object.keys(all.find((p) => p.id === "cli1")!).sort()).toEqual(["addr", "at", "by", "id", "name", "person", "role", "state"]);
    expect(all.find((p) => p.id === "cli1")).toEqual({ id: "cli1", role: "client", name: "phone", person: "owner@example.com", addr: "phone~owner@example.com", state: "ok", by: "seed", at: 2 });
    expect((await gate.list("host")).map((p) => p.addr)).toEqual(hosts.map((p) => p.addr));
    expect((await gate.list("client")).map((p) => p.id)).toEqual(["cli1"]);
    expect((await gate.list()).map((p) => p.id)).toEqual(all.map((p) => p.id));
  });

  it("7309 · keys.list отдаёт адрес предъявленного пропуска: два phone разных почт — у каждого свой", async () => {
    const a = await redeemed({ role: "client", name: "phone", person: "a@x" });
    const b = await redeemed({ role: "client", name: "phone", person: "b@y" });
    expect((await post({ type: "keys.list", key: a.key, role: "host" })).result.you).toBe("phone~a@x");
    expect((await post({ type: "keys.list", key: b.key })).result.you).toBe("phone~b@y");
  });

  it("роль не та: keys.list — bad_request и причина в журнале", async () => {
    const by = await agent();
    const who = (await gate.verify(by)) as { addr: string };
    expect(await post({ type: "keys.list", key: by, role: "admin" })).toMatchObject({ ok: false, error: "bad_request" });
    expect(logs).toContainEqual(`bad_request keys.list от ${who.addr} · role — host или client`);
  });
});

describe("вход по адресу gate", () => {
  it("5014 · база не ответила → POST gate_unavailable 503 с id и причиной в журнале; привязка verify бросает", async () => {
    const down = { DB: { prepare() { throw new Error("D1_ERROR: недоступна"); } } as unknown as D1Database };
    const key = `host.laptop.k7f3.${"A".repeat(43)}`;
    const r = await send(JSON.stringify({ type: "keys.list", id: "d1", v: 1, key }), down);
    expect(r.status).toBe(503);
    expect(r.headers.get("access-control-allow-origin")).toBe("*");
    expect(await r.json()).toEqual({ type: "reply", id: "d1", ok: false, error: "gate_unavailable" });
    expect(logs).toContain("gate_unavailable D1_ERROR: недоступна");
  });

  it.each([
    ["verify", (g: GateApi) => g.verify(`host.laptop.k7f3.${"A".repeat(43)}`)],
    ["revoke", (g: GateApi) => g.revoke("k7f3")],
    ["revoked", (g: GateApi) => g.revoked(["k7f3"])],
    ["list", (g: GateApi) => g.list()],
  ] as Array<[string, (g: GateApi) => Promise<unknown>]>)("5014 · база не ответила: привязка %s бросает, это не слово отказа", async (_n, call) => {
    const down = { DB: { prepare() { throw new Error("D1_ERROR: недоступна"); } } } as never;
    await expect(call(new Gate(createExecutionContext(), down) as unknown as GateApi)).rejects.toThrow("D1_ERROR: недоступна");
  });

  it.each([
    ["keys.list без пропуска", { type: "keys.list" }, "bad_key"],
    ["keys.invite с плохим пропуском", { type: "keys.invite", key: "x", role: "host", name: "a" }, "bad_key"],
    ["без версии", { type: "keys.list", key: "x", v: undefined }, "contract_mismatch"],
    ["версия не та", { type: "gate.redeem", invite: "x", v: 2 }, "contract_mismatch"],
    ["чужое имя", { type: "gate.verify", key: "x" }, "unknown_request"],
    ["имя чужого запроса", { type: "gate.revoke", kid: "x" }, "unknown_request"],
  ])("%s → отказ словом, код 200", async (_n, f, word) => {
    const r = await send(JSON.stringify({ id: "r1", v: 1, ...f }));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ type: "reply", id: "r1", ok: false, error: word });
  });

  it("слова accepts и причины — в журнале", async () => {
    await post({ type: "keys.list", key: "x", v: 2 });
    await post({ type: "gate.verify" });
    expect(logs[0]).toMatch(/^contract_mismatch keys\.list — запрошена v2, здесь v1/);
    expect(logs[1]).toBe("unknown_request gate.verify не обслуживается");
  });

  it.each([
    ["не JSON", "не кадр"],
    ["кадр без типа", JSON.stringify({ id: "x" })],
    ["кадр без id", JSON.stringify({ type: "keys.list", v: 1 })],
  ])("%s → bad_frame, код 200", async (_n, body) => {
    const r = await send(body);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ type: "reply", ok: false, error: "bad_frame" });
  });

  it("предел тела 16 КиБ: ровно предел идёт в разбор, больше — too_large 413", async () => {
    const pad = (len: number) => {
      const base = JSON.stringify({ type: "keys.list", id: "p", v: 1, key: "x", pad: "" });
      return JSON.stringify({ type: "keys.list", id: "p", v: 1, key: "x", pad: "x".repeat(len - base.length) });
    };
    const at = await send(pad(16 * 1024));
    expect(await at.json()).toMatchObject({ id: "p", error: "bad_key" });
    const over = await send(pad(16 * 1024 + 1));
    expect(over.status).toBe(413);
    expect(await over.json()).toEqual({ type: "reply", id: "", ok: false, error: "too_large" });
  });

  it("не POST → 404 без тела; ответ читается с любого адреса", async () => {
    const r = await worker.fetch(new Request("https://gate/"), env as never);
    expect(r.status).toBe(404);
    expect(await r.text()).toBe("");
    const p = await send("{}");
    expect(p.headers.get("access-control-allow-origin")).toBe("*");
  });
});

const PHONE: VerifyResult = { role: "client", name: "phone", kid: "p3a1", addr: "phone~owner@example.com" };

function fakeGate(r: VerifyResult | "throw"): GateApi & { keys: string[] } {
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

const framePost = (f: Record<string, unknown>) => new Request("https://push.example/", { method: "POST", body: JSON.stringify(f) });

describe("общий вход Worker'ов", () => {
  it("5041 · POST: кадр с key → gate.verify → frame с from и номером → reply телом; key до frame не доходит", async () => {
    const g = fakeGate(PHONE);
    const seen: Frame[] = [];
    const r = await entrance(framePost({ type: "push.key", id: "1", v: 1, key: "client.phone.p3a1.secret" }), g, (f) => {
      seen.push(f);
      return [{ type: "reply", id: "1", ok: true, result: { key: "K" }, to: f.from } as Frame];
    });
    expect(g.keys).toEqual(["client.phone.p3a1.secret"]);
    expect(seen).toEqual([{ type: "push.key", id: "1", v: 1, from: "phone~owner@example.com", fromKid: "p3a1" }]);
    expect(r.status).toBe(200);
    expect(r.headers.get("access-control-allow-origin")).toBe("*");
    expect(await r.json()).toEqual({ type: "reply", id: "1", ok: true, result: { key: "K" }, to: "phone~owner@example.com" });
  });

  it("5042 · from и fromKid в кадре не берутся: отправитель — адрес пропуска; 5183 · поле kid запроса доходит как есть", async () => {
    const seen: Frame[] = [];
    await entrance(framePost({ type: "keys.revoke", id: "1", v: 1, key: "k", kid: "zz11", from: "@win", fromKid: "zzzz" }), fakeGate(PHONE), (f) => (seen.push(f), []));
    expect(seen[0]).toMatchObject({ kid: "zz11", from: "phone~owner@example.com", fromKid: "p3a1" });
    expect(seen[0]).not.toHaveProperty("key");
  });

  it("кадр без пропуска: verify получает пустую строку", async () => {
    const g = fakeGate({ error: "bad_key" });
    await entrance(framePost({ type: "push.key", id: "1", v: 1 }), g, () => [], () => {});
    expect(g.keys).toEqual([""]);
  });

  it("5043 · плохой пропуск — слово gate и строка журнала; gate не ответил — gate_unavailable 503; обработчик не вызван", async () => {
    let calls = 0;
    const h = () => (calls++, []);
    const log: string[] = [];
    const line = (l: string) => void log.push(l);
    const bad = await entrance(framePost({ type: "push.key", id: "1", v: 1, key: "x" }), fakeGate({ error: "bad_key" }), h, line);
    expect(bad.status).toBe(200);
    expect(await bad.json()).toEqual({ type: "reply", id: "1", ok: false, error: "bad_key" });
    const down = await entrance(framePost({ type: "push.key", id: "3", v: 1, key: "x" }), fakeGate("throw"), h, line);
    expect(log).toEqual(["bad_key push.key", "gate_unavailable push.key · Error: база gate не ответила"]);
    expect(down.status).toBe(503);
    expect(await down.json()).toEqual({ type: "reply", id: "3", ok: false, error: "gate_unavailable" });
    expect(calls).toBe(0);
  });

  it("5045 · кадр без id → принят, 204 без тела", async () => {
    const seen: Frame[] = [];
    const r = await entrance(framePost({ type: "ledger.add", v: 1, key: "k", ev: "x" }), fakeGate(PHONE), (f) => (seen.push(f), []));
    expect(r.status).toBe(204);
    expect(await r.text()).toBe("");
    expect(seen).toHaveLength(1);
  });

  it.each([
    ["плохой пропуск", fakeGate({ error: "bad_key" }), () => [], 204],
    ["gate не ответил", fakeGate("throw"), () => [], 503],
    ["обработчик бросил", fakeGate(PHONE), () => { throw new Error("сбой"); }, 500],
  ] as Array<[string, GateApi, () => Frame[], number]>)("кадр без id, %s: тела нет, код отказа", async (_n, g, h, status) => {
    const r = await entrance(framePost({ type: "ledger.add", v: 1, key: "k" }), g, h, () => {});
    expect(r.status).toBe(status);
    expect(await r.text()).toBe("");
    expect(r.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("5046 · frame вернул кадр другому → не ушёл, строка relay_only; ответ отправителю — как обычно", async () => {
    const logs2: string[] = [];
    const r = await entrance(
      framePost({ type: "points.put", id: "1", v: 1, key: "k" }),
      fakeGate(PHONE),
      (f) => [{ type: "points.changed", to: "@win" } as Frame, { type: "reply", id: "1", ok: true, to: f.from } as Frame],
      (l) => logs2.push(l),
    );
    expect(await r.json()).toMatchObject({ id: "1", ok: true });
    expect(logs2).toEqual(['relay_only points.changed → "@win" · ответ на points.put от phone~owner@example.com: такие кадры доставляет только relay']);
  });

  it.each([
    ["frame не вернул ответа", () => []],
    ["ответ с другим id", (f: Frame) => [{ type: "reply", id: "9", ok: true, to: f.from } as Frame]],
    ["ответ другому адресу", () => [{ type: "reply", id: "1", ok: true, to: "@win" } as Frame]],
  ])("%s → no_reply", async (_n, h) => {
    const r = await entrance(framePost({ type: "points.put", id: "1", v: 1, key: "k" }), fakeGate(PHONE), h as never, () => {});
    expect(await r.json()).toEqual({ type: "reply", id: "1", ok: false, error: "no_reply" });
  });

  it("не POST — 404; не кадр — bad_frame 400; больше MAX_FRAME — too_large 413; обработчик бросил — failed 500 и строка журнала", async () => {
    expect((await entrance(new Request("https://push.example/"), fakeGate(PHONE), () => [])).status).toBe(404);
    const bad = await entrance(new Request("https://push.example/", { method: "POST", body: "не кадр" }), fakeGate(PHONE), () => []);
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ type: "reply", id: "", ok: false, error: "bad_frame" });
    const big = await entrance(new Request("https://push.example/", { method: "POST", body: "x".repeat(MAX_FRAME + 1) }), fakeGate(PHONE), () => []);
    expect(big.status).toBe(413);
    expect(await big.json()).toEqual({ type: "reply", id: "", ok: false, error: "too_large" });
    const log: string[] = [];
    const boom = await entrance(framePost({ type: "push.key", id: "1", v: 1, key: "k" }), fakeGate(PHONE), () => { throw new Error("сбой"); }, (l) => void log.push(l));
    expect(log).toEqual(["failed push.key от phone~owner@example.com · Error: сбой"]);
    expect(boom.status).toBe(500);
    expect(await boom.json()).toEqual({ type: "reply", id: "1", ok: false, error: "failed" });
  });

  it("журнал по умолчанию — console.log", async () => {
    await entrance(framePost({ type: "push.key", id: "1", v: 1, key: "x" }), fakeGate({ error: "bad_key" }), () => []);
    expect(logs).toEqual(["bad_key push.key"]);
  });

  it("5182 · gate не ответил за предел — gate_unavailable 503, frame не звался", async () => {
    // источник: слово пользователя 2 нояб.: у всех операций лимит
    const late = vi.spyOn(globalThis, "setTimeout").mockImplementation(((cb: () => void) => (queueMicrotask(cb), 0)) as never);
    const hang: GateApi = { ...fakeGate(PHONE), verify: () => new Promise(() => {}) };
    const seen: Frame[] = [];
    const log: string[] = [];
    const r = await entrance(framePost({ type: "push.key", id: "1", v: 1, key: "k" }), hang, (f) => (seen.push(f), []), (l) => void log.push(l));
    late.mockRestore();
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ type: "reply", id: "1", ok: false, error: "gate_unavailable" });
    expect(log).toEqual(["gate_unavailable push.key · Error: gate не ответил на verify"]);
    expect(seen).toEqual([]);
  });
});

describe("стенд gate для соседей", () => {
  it("пропуск стенда: адрес машины и клиента; секрет bad, не тот вид и отозванный — bad_key; revoked; list из setHosts", async () => {
    const s = env.STAND;
    expect(await s.verify("host.laptop.k1.any")).toEqual({ role: "host", name: "laptop", kid: "k1", addr: "@laptop" });
    expect(await s.verify("client.phone.k2.any")).toEqual({ role: "client", name: "phone", kid: "k2", addr: "phone~test@example.com" });
    for (const k of ["host.laptop.k1.bad", "laptop", "admin.a.k.s"]) expect(await s.verify(k)).toEqual({ error: "bad_key" });
    expect(await s.revoke("k9")).toEqual({ addr: "?" });
    expect(await s.verify("host.a.k9.any")).toEqual({ error: "bad_key" });
    expect(await s.revoked(["k9", "host.a.k9", "k1"])).toEqual(["k9", "host.a.k9"]);
    expect(await s.list("host")).toEqual([]);
    await s.setHosts(["win", "wsl"]);
    expect(await s.list("host")).toEqual([
      { id: "win", role: "host", name: "win", person: null, addr: "@win", state: "ok", by: "stand", at: 0 },
      { id: "wsl", role: "host", name: "wsl", person: null, addr: "@wsl", state: "ok", by: "stand", at: 0 },
    ]);
    expect((await s.list()).map((p) => p.name)).toEqual(["win", "wsl"]);
    expect(await s.list("client")).toEqual([]);
    await s.setHosts([]);
  });
});
