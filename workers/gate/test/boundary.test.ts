// Леса границы «пропуск участника», среда Worker: пропуска над базой D1 стенда, вход OAuth, общий вход Worker'ов, стенд gate для соседей.
// Вход — POST кадра, HTTP OAuth, методы входа Gate, entrance и gateStand из контракта. Исход — ответ, строка базы, строка журнала.
// Номер — эталон-источник; свойства без пометки — чьё: код. Выданные пропуска не перевыдаются: verify берёт номер и секрет (эталон 43).
import { exports, env as rawEnv } from "cloudflare:workers";
import { applyD1Migrations, createExecutionContext, type D1Migration } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_FRAME, type Frame } from "@switchboard/protocol";
import { entrance, inviteOf, type GateApi, type Pass, type VerifyResult } from "../contract.ts";
import worker, { Gate } from "../src/index.ts";

type Stand = GateApi & { setHosts(names: string[]): Promise<void> };
type TestEnv = { DB: D1Database; PULT: string; TEST_MIGRATIONS: D1Migration[]; TEST_SEED: { sql: string; invite: string }; STAND: Stand };
type Reply = { type: string; id: string; ok: boolean; result?: any; error?: string };

const env = rawEnv as unknown as TestEnv;
const gate = (exports as unknown as { Gate: GateApi }).Gate;
let logs: string[] = [];
let n = 0;

const send = (body: string, e: { DB: D1Database } = env) => worker.fetch(new Request("https://gate/", { method: "POST", body }), e as never);
/** POST по адресу gate: кадр → reply. */
async function post(f: Record<string, unknown>): Promise<Reply> {
  const v = f.type === "gate.redeem" ? 1 : 2;
  return (await send(JSON.stringify({ id: String(++n), v, ...f }))).json();
}

const sha256 = async (t: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t)))].map((b) => b.toString(16).padStart(2, "0")).join("");
const b64url = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
const s256 = async (t: string) => b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t)));
const SIG = "S".repeat(43);
const DAY = 24 * 3600_000;

/** Принятый пропуск прямо строкой базы; prefix — подпись пропуска как выдана (прежняя выдача — role.name). */
async function passRow(addr: string, kid: string, o: { owner?: string; at?: number; prefix?: string } = {}): Promise<string> {
  await env.DB.prepare("INSERT INTO passes (id, addr, owner, state, hash, by, at) VALUES (?, ?, ?, 'ok', ?, 'seed', ?)").bind(kid, addr, o.owner ?? null, await sha256(SIG), o.at ?? 1).run();
  return `${o.prefix ?? addr.replace(/^@/, "").split(/[~@]/)[0]}.${kid}.${SIG}`;
}
const agent = () => passRow(`agent${++n}~agent@example.com`, `a${String(n).padStart(3, "0")}`.slice(0, 4));
const invited = async (f: Record<string, unknown>, by?: string) => (await post({ type: "keys.invite", key: by ?? (await agent()), ...f })).result as { kid: string; invite: string; addr: string };
const redeemed = async (f: Record<string, unknown>) => {
  const inv = await invited(f);
  return { ...inv, key: (await post({ type: "gate.redeem", invite: inv.invite })).result.key as string };
};
const row = (id: string) => env.DB.prepare("SELECT * FROM passes WHERE id = ?").bind(id).first<Record<string, unknown>>();
const rows = async () => (await env.DB.prepare("SELECT * FROM passes").all<Record<string, unknown>>()).results;

beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.DB.exec("DELETE FROM passes");
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
});
afterEach(() => vi.restoreAllMocks());

describe("приглашение и приём", () => {
  it("1 · 5001 · 5006 · устройство от имени человека: invite → строка «ждёт приёма»; redeem → пропуск pult.номер.секрет, verify — номер и адрес; второй redeem — bad_invite; секретов нет ни в журнале, ни в базе", async () => {
    const by = await agent();
    const inv = await post({ type: "keys.invite", key: by, addr: "pult~ann@example.com" });
    expect(inv).toMatchObject({ type: "reply", ok: true });
    expect(Object.keys(inv.result).sort()).toEqual(["addr", "invite", "kid"]);
    expect(inv.result.invite).toMatch(/^[a-z0-9]{4}\.[A-Za-z0-9_-]{43}$/);
    const [kid, code] = inv.result.invite.split(".");
    expect(inv.result).toMatchObject({ kid, addr: "pult~ann@example.com" });
    const waiting = (await row(kid))!;
    expect(waiting).toMatchObject({ addr: "pult~ann@example.com", owner: null, state: "wait", hash: await sha256(code), by: expect.stringMatching(/~agent@example\.com$/) });
    expect(logs).toContainEqual(`invite ${kid} pult~ann@example.com · выдал ${waiting.by}`);

    const r1 = await post({ type: "gate.redeem", invite: inv.result.invite });
    expect(Object.keys(r1.result)).toEqual(["key", "addr", "kid"]);
    expect(r1.result.key).toMatch(new RegExp(`^pult\\.${kid}\\.[A-Za-z0-9_-]{43}$`));
    const taken = (await row(kid))!;
    expect(taken.state).toBe("ok");
    expect(taken.hash).toBe(await sha256(r1.result.key.split(".")[2]));
    expect(logs).toContainEqual(`redeem pult.${kid} pult~ann@example.com · принят`);
    const kept = logs.join("\n") + JSON.stringify(await rows());
    expect(kept).not.toContain(r1.result.key.split(".")[2]);
    expect(kept).not.toContain(code);

    expect(await post({ type: "gate.redeem", invite: inv.result.invite })).toMatchObject({ ok: false, error: "bad_invite" });
    expect(await gate.verify(r1.result.key)).toEqual({ kid, addr: "pult~ann@example.com" });
  });

  it("виды пропуска — формы адреса: машина с владельцем, сессия, программа — устройство; подпись пропуска — имя адреса", async () => {
    const m = await redeemed({ addr: "@laptop", owner: "~ann@example.com" });
    expect(m.key).toMatch(new RegExp(`^laptop\\.${m.kid}\\.`));
    expect(await row(m.kid)).toMatchObject({ addr: "@laptop", owner: "~ann@example.com" });
    const s = await redeemed({ addr: "site@laptop" });
    expect(s.key).toMatch(new RegExp(`^site\\.${s.kid}\\.`));
    const p = await redeemed({ addr: "alerts~ann@example.com" });
    expect(await gate.verify(p.key)).toEqual({ kid: p.kid, addr: "alerts~ann@example.com" });
  });

  it("приглашение живёт сутки: старше — bad_invite; адрес просроченного свободен для нового", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const by = await agent();
    const inv = await invited({ addr: "phone~ann@example.com" }, by);
    clock.mockReturnValue(1_000_000 + DAY + 1);
    expect(await post({ type: "gate.redeem", invite: inv.invite })).toMatchObject({ ok: false, error: "bad_invite" });
    expect(logs.at(-1)).toMatch(/^bad_invite приглашения .* старше суток/);
    const again = await post({ type: "keys.invite", key: by, addr: "phone~ann@example.com" });
    expect(again.ok).toBe(true);
    expect(await row(inv.kid)).toBeNull();
  });

  it("gate.redeem без пропуска: приглашение не того вида или секрет не тот — bad_invite, причина в журнале, строка ждёт дальше", async () => {
    const S = "A".repeat(43);
    for (const invite of ["nope", `xabcd.${S}`, `abcd.${S}x`, { toString: null }]) {
      logs = [];
      expect(await post({ type: "gate.redeem", invite })).toMatchObject({ ok: false, error: "bad_invite" });
      expect(logs).toEqual(["bad_invite приглашение не того вида: номер.секрет"]);
    }
    const inv = await invited({ addr: "@laptop" });
    expect(await post({ type: "gate.redeem", invite: `${inv.kid}.${"A".repeat(43)}` })).toMatchObject({ ok: false, error: "bad_invite" });
    expect((await row(inv.kid))!.state).toBe("wait");
    expect(await post({ type: "gate.redeem", invite: inv.invite })).toMatchObject({ ok: true });
  });

  it("одно приглашение, два приёма разом → один пропуск, второй bad_invite", async () => {
    const inv = await invited({ addr: "@laptop" });
    const both = await Promise.all([post({ type: "gate.redeem", invite: inv.invite }), post({ type: "gate.redeem", invite: inv.invite })]);
    expect(both.map((r) => r.ok).sort()).toEqual([false, true]);
    expect(await gate.verify(both.find((r) => r.ok)!.result.key)).toMatchObject({ addr: "@laptop" });
  });

  it("5013 · инструкция настоящего seed → в базе строка «ждёт приёма»; redeem даёт пропуск, который проходит verify", async () => {
    const s = env.TEST_SEED;
    await env.DB.exec(s.sql);
    const [kid] = s.invite.split(".");
    expect(await row(kid)).toMatchObject({ addr: "@first", owner: null, state: "wait", by: "seed" });
    const { key } = (await post({ type: "gate.redeem", invite: s.invite })).result;
    expect(key).toMatch(new RegExp(`^first\\.${kid}\\.`));
    expect(await gate.verify(key)).toEqual({ kid, addr: "@first" });
  });

  it("5008 · адрес с живым пропуском → name_taken, причина в журнале; другой человек — другой адрес; после отзыва проходит", async () => {
    const by = await agent();
    const who = (await gate.verify(by)) as { addr: string };
    const a = await invited({ addr: "phone~owner@example.com" }, by);
    expect(await post({ type: "keys.invite", key: by, addr: "phone~owner@example.com" })).toMatchObject({ ok: false, error: "name_taken" });
    expect(logs).toContainEqual(`name_taken keys.invite от ${who.addr} · у адреса phone~owner@example.com есть живой пропуск`);
    expect((await post({ type: "keys.invite", key: by, addr: "phone~other@example.com" })).ok).toBe(true);
    await gate.revoke(a.kid);
    expect((await post({ type: "keys.invite", key: by, addr: "phone~owner@example.com" })).ok).toBe(true);
  });

  it("номер занят — приглашение получает другой номер; три занятых подряд — gate_unavailable, причина в журнале", async () => {
    const by = await agent();
    await passRow("@busy", "aaaa");
    const real = crypto.getRandomValues.bind(crypto);
    let script = [0, 1];
    vi.spyOn(crypto, "getRandomValues").mockImplementation(((a: Uint8Array) => {
      if (a.length !== 4) return real(a);
      return a.fill(script.shift() ?? 0);
    }) as never);
    const inv = await post({ type: "keys.invite", key: by, addr: "@laptop" });
    expect(inv.result.kid).toBe("bbbb");
    script = [0, 0, 0, 2];
    const r = await post({ type: "keys.invite", key: by, addr: "@next" });
    expect(r).toMatchObject({ ok: false, error: "gate_unavailable" });
    expect(logs).toContainEqual("gate_unavailable три номера подряд заняты");
  });

  it.each([
    ["адреса нет", {}, "addr — @машина, устройство~почта или сессия@машина"],
    ["адрес человека", { addr: "~ann@example.com" }, "addr — @машина, устройство~почта или сессия@машина"],
    ["служба", { addr: ".relay" }, "addr — @машина, устройство~почта или сессия@машина"],
    ["машина с точкой", { addr: "@lap.top" }, "addr — имена A-Z a-z 0-9 _ -, почта человека после ~"],
    ["почта без @", { addr: "pult~ann" }, "addr — имена A-Z a-z 0-9 _ -, почта человека после ~"],
    ["owner у устройства", { addr: "pult~a@b.c", owner: "~a@b.c" }, "owner — ~почта, только у машины"],
    ["owner без ~", { addr: "@laptop", owner: "a@b.c" }, "owner — ~почта, только у машины"],
    ["challenge без client", { addr: "code~a@b.c", challenge: "C".repeat(43) }, "challenge, client и back — вместе и только у устройства"],
    ["OAuth у машины", { addr: "@laptop", challenge: "C".repeat(43), client: "https://c/", back: "https://b/" }, "challenge, client и back — вместе и только у устройства"],
    ["client не https", { addr: "code~a@b.c", challenge: "C".repeat(43), client: "http://c/", back: "https://b/" }, "challenge — S256 в base64url, client — https, back — адрес"],
  ])("keys.invite: %s → bad_request, причина в журнале, строки нет", async (_n, fields, why) => {
    const by = await agent();
    const who = (await gate.verify(by)) as { addr: string };
    const before = (await rows()).length;
    expect(await post({ type: "keys.invite", key: by, ...fields })).toMatchObject({ ok: false, error: "bad_request" });
    expect(logs).toContainEqual(`bad_request keys.invite от ${who.addr} · ${why}`);
    expect((await rows()).length).toBe(before);
  });
});

describe("приглашение в тексте", () => {
  it("с точкой и с подчёркиванием из ссылки — одно приглашение; другой текст — null", () => {
    // источник: факт — Telegram не принимает точку в параметре ссылки
    const secret = "s".repeat(43);
    expect(inviteOf(`abcd.${secret}`)).toBe(`abcd.${secret}`);
    expect(inviteOf(`abcd_${secret}\n`)).toBe(`abcd.${secret}`);
    expect(inviteOf("обычное сообщение")).toBeNull();
    expect(inviteOf(`abcd.${secret}x`)).toBeNull();
  });
});

describe("проверка пропуска", () => {
  it("5003 · 5005 · verify отдаёт правду строки: номер и адрес, строка не меняется, задержка в журнале", async () => {
    const m = await redeemed({ addr: "@laptop" });
    const before = await rows();
    const clock = vi.spyOn(Date, "now").mockReturnValueOnce(1_000).mockReturnValue(1_007);
    expect(await gate.verify(m.key)).toEqual({ kid: m.kid, addr: "@laptop" });
    clock.mockRestore();
    expect(await rows()).toEqual(before);
    expect(logs).toContainEqual(`ok laptop.${m.kid} → @laptop · 7 мс`);
  });

  it("43 · пропуска не перевыдаются: прежние host.laptop.номер.секрет и client.phone.номер.секрет после перевода базы — verify номером и адресом; подпись не сверяется", async () => {
    const host = await passRow("@laptop", "k7f3", { prefix: "host.laptop" });
    const phone = await passRow("phone~ann@example.com", "k2a9", { prefix: "client.phone" });
    expect(await gate.verify(host)).toEqual({ kid: "k7f3", addr: "@laptop" });
    expect(await gate.verify(phone)).toEqual({ kid: "k2a9", addr: "phone~ann@example.com" });
    expect(await gate.verify(`other.k7f3.${SIG}`)).toEqual({ kid: "k7f3", addr: "@laptop" });
  });

  it("43 · перевод базы: строки прежней выдачи — адрес как был, владелец машины — человек выдавшего устройства", async () => {
    const before = env.TEST_MIGRATIONS.filter((m) => m.name < "0003");
    const db = env.DB;
    await db.exec("DROP TABLE IF EXISTS passes");
    await db.exec("DROP TABLE IF EXISTS d1_migrations");
    await applyD1Migrations(db, before);
    await db.exec(
      "INSERT INTO passes (id, role, name, person, state, hash, by, at) VALUES ('k7f3', 'host', 'laptop', NULL, 'ok', 'h', 'pult~ann@example.com', 1), ('k8f3', 'host', 'pc', NULL, 'ok', 'h', 'seed', 2), ('k2a9', 'client', 'phone', 'ann@example.com', 'ok', 'h', '@laptop', 3)",
    );
    await applyD1Migrations(db, env.TEST_MIGRATIONS);
    expect((await rows()).map((r) => [r.id, r.addr, r.owner])).toEqual([
      ["k7f3", "@laptop", "~ann@example.com"],
      ["k8f3", "@pc", null],
      ["k2a9", "phone~ann@example.com", null],
    ]);
  });

  it("5004 · verify: bad_key и причина в журнале, база не меняется: секрет не тот, номера нет, пропуск не принят, отозван", async () => {
    const { key, kid } = await redeemed({ addr: "@laptop" });
    const wait = await invited({ addr: "@wait" });
    const cases: Array<[string, string]> = [
      [`laptop.${kid}.${"A".repeat(43)}`, `^bad_key laptop\\.${kid} · секрет не тот · \\d+ мс$`],
      ["host.laptop.k7f3.c2lnbmF0dXJl", "^bad_key host\\.laptop\\.k7f3 · номера нет в базе · \\d+ мс$"],
      [`wait.${wait.kid}.${wait.invite.split(".")[1]}`, `^bad_key wait\\.${wait.kid} · пропуск не принят · \\d+ мс$`],
    ];
    for (const [k, line] of cases) {
      logs = [];
      expect(await gate.verify(k)).toEqual({ error: "bad_key" });
      expect(logs).toEqual([expect.stringMatching(new RegExp(line))]);
    }
    await gate.revoke(kid);
    logs = [];
    expect(await gate.verify(key)).toEqual({ error: "bad_key" });
    expect(logs).toEqual([expect.stringMatching(new RegExp(`^bad_key laptop\\.${kid} · номера нет в базе · \\d+ мс$`))]);
  });

  it.each([
    ["без подписи", "k7f3.Jx9w"],
    ["пробел", "a b.k7f3.sig"],
    ["не строка", 42],
  ])("114 · пропуск не того вида: %s — bad_key без исключения, причина в журнале", async (_n, k) => {
    expect(await gate.verify(k as string)).toEqual({ error: "bad_key" });
    expect(logs).toEqual(["bad_key пропуск не того вида: нужно подпись.номер.секрет"]);
  });

  it("114 · пропуск только строкой: настоящий пропуск в списке не входит; объект, который не привести к строке, — bad_key, а не сбой базы", async () => {
    const { key } = await redeemed({ addr: "@laptop" });
    for (const bad of [{ toString: null }, [key]]) {
      logs = [];
      expect(await post({ type: "keys.list", key: bad })).toMatchObject({ ok: false, error: "bad_key" });
      expect(logs).toEqual(["bad_key пропуск не того вида: нужно подпись.номер.секрет"]);
    }
  });
});

describe("отзыв", () => {
  it("7305 · 5002 · отзыв удаляет строку: приглашение не принять, номера нет, второй отзыв — unknown_key, адрес свободен; журнал", async () => {
    const by = await agent();
    const a = await invited({ addr: "@laptop" }, by);
    expect(await gate.revoke(a.kid)).toEqual({ addr: "@laptop" });
    expect(logs).toContainEqual(`revoked ${a.kid} @laptop · строка удалена`);
    expect(await row(a.kid)).toBeNull();
    expect(await post({ type: "gate.redeem", invite: a.invite })).toMatchObject({ ok: false, error: "bad_invite" });
    expect(await gate.revoke(a.kid)).toEqual({ error: "unknown_key" });
    expect(logs).toContainEqual(`unknown_key ${a.kid} · отзыв`);
    expect(await post({ type: "keys.invite", key: by, addr: "@laptop" })).toMatchObject({ ok: true });
  });
});

describe("список пропусков", () => {
  it("5012 · keys.list: все по времени, поля {kid, addr, owner, wait}; kind — форма адреса; ids — только живые из названных, 150 за раз; привязка list — то же", async () => {
    const by = await agent();
    await invited({ addr: "@wait-machine" }, by);
    const gone = await redeemed({ addr: "@gone" });
    await gate.revoke(gone.kid);
    await passRow("phone~owner@example.com", "cli1", { at: 2 });
    await passRow("@older", "old1", { at: 0, owner: "~ann@example.com" });
    await passRow("site@older", "ses1", { at: 3 });
    const all: Pass[] = (await post({ type: "keys.list", key: by })).result.passes;
    expect(all[0]).toEqual({ kid: "old1", addr: "@older", owner: "~ann@example.com", wait: false });
    expect(all.filter((p) => !p.addr.startsWith("agent")).map((p) => p.kid).slice(0, 3)).toEqual(["old1", "cli1", "ses1"]);
    expect(all.find((p) => p.addr === "@wait-machine")).toMatchObject({ wait: true });
    const machines: Pass[] = (await post({ type: "keys.list", key: by, kind: "machine" })).result.passes;
    expect(machines.map((p) => p.addr)).toEqual(["@older", "@wait-machine"]);
    expect((await post({ type: "keys.list", key: by, kind: "session" })).result.passes.map((p: Pass) => p.kid)).toEqual(["ses1"]);
    const many = Array.from({ length: 150 }, (_, i) => `gone-${i}`);
    expect((await post({ type: "keys.list", key: by, ids: [...many, "cli1", gone.kid] })).result.passes.map((p: Pass) => p.kid)).toEqual(["cli1"]);
    expect((await gate.list({ kind: "machine" })).map((p) => p.addr)).toEqual(machines.map((p) => p.addr));
    expect((await gate.list({ ids: ["cli1", "zzzz"] })).map((p) => p.kid)).toEqual(["cli1"]);
    expect((await gate.list()).map((p) => p.kid)).toEqual(all.map((p) => p.kid));
  });

  it("7309 · keys.list отдаёт адрес предъявленного пропуска: два phone разных почт — у каждого свой", async () => {
    const a = await redeemed({ addr: "phone~a@x.y" });
    const b = await redeemed({ addr: "phone~b@y.z" });
    expect((await post({ type: "keys.list", key: a.key, kind: "machine" })).result.you).toBe("phone~a@x.y");
    expect((await post({ type: "keys.list", key: b.key })).result.you).toBe("phone~b@y.z");
  });

  it.each([
    ["kind не тот", { kind: "host" }, "kind — machine, device или session"],
    ["ids не список", { ids: "k1" }, "ids — список номеров"],
  ])("keys.list: %s — bad_request и причина в журнале", async (_n, f, why) => {
    const by = await agent();
    const who = (await gate.verify(by)) as { addr: string };
    expect(await post({ type: "keys.list", key: by, ...f })).toMatchObject({ ok: false, error: "bad_request" });
    expect(logs).toContainEqual(`bad_request keys.list от ${who.addr} · ${why}`);
  });
});

describe("вход OAuth", () => {
  const CLIENT = "https://claude.ai/oauth/mcp-oauth-client-metadata";
  const BACK = "https://claude.ai/api/mcp/auth_callback";
  const CODE_CLIENT = "https://claude.ai/oauth/claude-code-client-metadata";
  const http = (path: string, init?: RequestInit) => worker.fetch(new Request(`https://gate.example${path}`, init), env as never);
  const form = (o: Record<string, string>) => http("/token", { method: "POST", body: new URLSearchParams(o).toString(), headers: { "content-type": "application/x-www-form-urlencoded" } });

  /** Описания клиентов по адресу: подделка fetch; чужой адрес — 404. */
  const clients = new Map<string, unknown>();
  const describeClient = (id: string, uris: string[]) => clients.set(id, { client_id: id, client_name: "Claude", redirect_uris: uris });
  beforeEach(() => {
    clients.clear();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (u) => (clients.has(String(u)) ? Response.json(clients.get(String(u))) : new Response("", { status: 404 })));
  });

  it("метаданные сервера входа: authorization_endpoint — согласие пульта, token — gate, описание клиента по адресу, S256", async () => {
    const r = await http("/.well-known/oauth-authorization-server");
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({
      issuer: "https://gate.example",
      authorization_endpoint: env.PULT,
      token_endpoint: "https://gate.example/token",
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      client_id_metadata_document_supported: true,
    });
  });

  it("23 · согласие → keys.invite с challenge, client и back; /token с code_verifier → access_token — пропуск устройства; второй обмен — invalid_grant", async () => {
    describeClient(CLIENT, [BACK]);
    const verifier = "v".repeat(64);
    const pult = await agent();
    const inv = await post({ type: "keys.invite", key: pult, addr: "claude~ann@example.com", challenge: await s256(verifier), client: CLIENT, back: BACK });
    expect(inv.ok).toBe(true);
    expect(await post({ type: "gate.redeem", invite: inv.result.invite })).toMatchObject({ ok: false, error: "bad_invite" });
    const wrong = await form({ grant_type: "authorization_code", code: inv.result.invite, code_verifier: "x".repeat(64), client_id: CLIENT, redirect_uri: BACK });
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toMatchObject({ error: "invalid_grant" });
    const r = await form({ grant_type: "authorization_code", code: inv.result.invite, code_verifier: verifier, client_id: CLIENT, redirect_uri: BACK });
    expect(r.status).toBe(200);
    const t = (await r.json()) as { access_token: string; token_type: string };
    expect(t.token_type).toBe("Bearer");
    expect(t.access_token).toMatch(new RegExp(`^claude\\.${inv.result.kid}\\.`));
    expect(await gate.verify(t.access_token)).toEqual({ kid: inv.result.kid, addr: "claude~ann@example.com" });
    expect(await (await form({ grant_type: "authorization_code", code: inv.result.invite, code_verifier: verifier, client_id: CLIENT, redirect_uri: BACK })).json()).toMatchObject({ error: "invalid_grant" });
  });

  it("44 · Claude Code: адрес возврата 127.0.0.1 с любым портом; claude.ai и Claude Code одного человека — два устройства, оба живы", async () => {
    describeClient(CODE_CLIENT, ["http://127.0.0.1/callback", "http://localhost/callback"]);
    describeClient(CLIENT, [BACK]);
    const v = "w".repeat(50);
    const pult = await agent();
    const back = "http://127.0.0.1:53111/callback";
    const a = await post({ type: "keys.invite", key: pult, addr: "code~ann@example.com", challenge: await s256(v), client: CODE_CLIENT, back });
    const b = await post({ type: "keys.invite", key: pult, addr: "claude~ann@example.com", challenge: await s256(v), client: CLIENT, back: BACK });
    const ta = (await (await form({ grant_type: "authorization_code", code: a.result.invite, code_verifier: v, client_id: CODE_CLIENT, redirect_uri: back })).json()) as { access_token: string };
    const tb = (await (await form({ grant_type: "authorization_code", code: b.result.invite, code_verifier: v, client_id: CLIENT, redirect_uri: BACK })).json()) as { access_token: string };
    expect(await gate.verify(ta.access_token)).toMatchObject({ addr: "code~ann@example.com" });
    expect(await gate.verify(tb.access_token)).toMatchObject({ addr: "claude~ann@example.com" });
  });

  it("адреса возврата нет в описании клиента — bad_client, строки нет; описание не отвечает — bad_client", async () => {
    describeClient(CLIENT, [BACK]);
    const pult = await agent();
    const before = (await rows()).length;
    expect(await post({ type: "keys.invite", key: pult, addr: "claude~ann@example.com", challenge: "C".repeat(43), client: CLIENT, back: "https://evil.example/cb" })).toMatchObject({ ok: false, error: "bad_client" });
    expect(logs.at(-1)).toMatch(/^bad_client keys\.invite от .* · https:\/\/evil\.example\/cb нет в redirect_uris/);
    expect(await post({ type: "keys.invite", key: pult, addr: "claude~ann@example.com", challenge: "C".repeat(43), client: "https://claude.ai/gone", back: BACK })).toMatchObject({ ok: false, error: "bad_client" });
    expect((await rows()).length).toBe(before);
  });

  it("/token: не authorization_code — unsupported_grant_type; без полей — invalid_request", async () => {
    expect(await (await form({ grant_type: "refresh_token" })).json()).toMatchObject({ error: "unsupported_grant_type" });
    expect(await (await form({ grant_type: "authorization_code", code: "x" })).json()).toMatchObject({ error: "invalid_request" });
  });
});

describe("вход по адресу gate", () => {
  it("5014 · база не ответила → POST gate_unavailable 503 с id и причиной в журнале; привязка verify бросает", async () => {
    const down = { DB: { prepare() { throw new Error("D1_ERROR: недоступна"); } } as unknown as D1Database };
    const key = `laptop.k7f3.${"A".repeat(43)}`;
    const r = await send(JSON.stringify({ type: "keys.list", id: "d1", v: 2, key }), down);
    expect(r.status).toBe(503);
    expect(r.headers.get("access-control-allow-origin")).toBe("*");
    expect(await r.json()).toEqual({ type: "reply", id: "d1", ok: false, error: "gate_unavailable" });
    expect(logs).toContain("gate_unavailable D1_ERROR: недоступна");
    await expect((new Gate(createExecutionContext(), down as never) as unknown as GateApi).verify(key)).rejects.toThrow("D1_ERROR: недоступна");
  });

  it.each([
    ["keys.list без пропуска", { type: "keys.list", v: 2 }, "bad_key"],
    ["без версии", { type: "keys.list", key: "x", v: undefined }, "contract_mismatch"],
    ["чужое имя", { type: "gate.verify", key: "x", v: 1 }, "unknown_request"],
  ])("%s → отказ словом, код 200", async (_n, f, word) => {
    const r = await send(JSON.stringify({ id: "r1", ...f }));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ type: "reply", id: "r1", ok: false, error: word });
  });

  it("слова accepts и причины — в журнале", async () => {
    await post({ type: "keys.list", key: "x", v: 1 });
    await post({ type: "gate.verify" });
    expect(logs[0]).toMatch(/^contract_mismatch keys\.list — запрошена v1, здесь v2/);
    expect(logs[1]).toBe("unknown_request gate.verify не обслуживается");
  });

  it.each([
    ["не JSON", "не кадр"],
    ["кадр без id", JSON.stringify({ type: "keys.list", v: 2 })],
  ])("%s → bad_frame", async (_n, body) => {
    expect(await (await send(body)).json()).toEqual({ type: "reply", id: "", ok: false, error: "bad_frame" });
  });

  it("дверь открыта без пропуска: кадр с пустым id — кадр без id, отказ словом: приглашение ждёт дальше, новой строки нет", async () => {
    const by = await agent();
    const inv = await invited({ addr: "@laptop" }, by);
    const before = await rows();
    for (const f of [{ type: "gate.redeem", v: 1, invite: inv.invite }, { type: "keys.invite", v: 2, key: by, addr: "@next" }, { type: "keys.list", v: 2, key: by }])
      expect(await (await send(JSON.stringify({ id: "", ...f }))).json()).toEqual({ type: "reply", id: "", ok: false, error: "bad_frame" });
    expect(await rows()).toEqual(before);
    expect(await post({ type: "gate.redeem", invite: inv.invite })).toMatchObject({ ok: true });
  });

  it("предел тела 16 КиБ: ровно предел идёт в разбор, больше — too_large 413", async () => {
    const pad = (len: number) => {
      const base = JSON.stringify({ type: "keys.list", id: "p", v: 2, key: "x", pad: "" });
      return JSON.stringify({ type: "keys.list", id: "p", v: 2, key: "x", pad: "x".repeat(len - base.length) });
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

const PHONE: VerifyResult = { kid: "p3a1", addr: "phone~owner@example.com" };

function fakeGate(r: VerifyResult | "throw"): GateApi & { keys: string[] } {
  const keys: string[] = [];
  return {
    keys,
    redeem: async () => ({ error: "bad_invite" }),
    async verify(k) {
      keys.push(k);
      if (r === "throw") throw new Error("база gate не ответила");
      return r;
    },
    async revoke() {
      return { error: "unknown_key" as const };
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

  it.each([
    ["в списке", ["client.phone.p3a1.secret"]],
    ["числом", 42],
    ["объектом, который не привести к строке", { toString: null }],
  ])("пропуск не строкой (%s): verify получает пустую строку, отказ — слово gate, а не gate_unavailable", async (_n, key) => {
    const g = fakeGate({ error: "bad_key" });
    const r = await entrance(framePost({ type: "push.key", id: "1", v: 1, key }), g, () => [], () => {});
    expect(g.keys).toEqual([""]);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ type: "reply", id: "1", ok: false, error: "bad_key" });
  });

  it("5043 · плохой пропуск — слово gate и строка журнала; gate не ответил — gate_unavailable 503; обработчик не вызван; журнал по умолчанию — console.log", async () => {
    let calls = 0;
    const h = () => (calls++, []);
    const bad = await entrance(framePost({ type: "push.key", id: "1", v: 1, key: "x" }), fakeGate({ error: "bad_key" }), h);
    expect(bad.status).toBe(200);
    expect(await bad.json()).toEqual({ type: "reply", id: "1", ok: false, error: "bad_key" });
    const down = await entrance(framePost({ type: "push.key", id: "3", v: 1, key: "x" }), fakeGate("throw"), h);
    expect(logs).toEqual(["bad_key push.key", "gate_unavailable push.key · Error: база gate не ответила"]);
    expect(down.status).toBe(503);
    expect(await down.json()).toEqual({ type: "reply", id: "3", ok: false, error: "gate_unavailable" });
    expect(calls).toBe(0);
  });

  it("5045 · кадр без id: принят — 204 без тела; обработчик бросил — 500 без тела", async () => {
    const seen: Frame[] = [];
    const r = await entrance(framePost({ type: "ledger.add", v: 1, key: "k", ev: "x" }), fakeGate(PHONE), (f) => (seen.push(f), []));
    expect(r.status).toBe(204);
    expect(await r.text()).toBe("");
    expect(seen).toHaveLength(1);
    const boom = await entrance(framePost({ type: "ledger.add", v: 1, key: "k" }), fakeGate(PHONE), () => { throw new Error("сбой"); }, () => {});
    expect(boom.status).toBe(500);
    expect(await boom.text()).toBe("");
    expect(boom.headers.get("access-control-allow-origin")).toBe("*");
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
    // кадр без id ответа не ждёт: кадр отправителю ответом не становится
    logs2.length = 0;
    await entrance(framePost({ type: "points.put", v: 1, key: "k" }), fakeGate(PHONE), (f) => [{ type: "points.changed", to: f.from } as Frame], (l) => logs2.push(l));
    expect(logs2).toEqual(['relay_only points.changed → "phone~owner@example.com" · ответ на points.put от phone~owner@example.com: такие кадры доставляет только relay']);
  });

  it.each([
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
  it("пропуск стенда: адрес машины и устройства; секрет bad, не тот вид и отозванный — bad_key; list по ids и kind, машины из setHosts", async () => {
    const s = env.STAND;
    expect(await s.verify("host.laptop.k1.any")).toEqual({ kid: "k1", addr: "@laptop" });
    expect(await s.verify("client.phone.k2.any")).toEqual({ kid: "k2", addr: "phone~test@example.com" });
    expect(await s.verify("pult.k3.any")).toEqual({ kid: "k3", addr: "pult~test@example.com" });
    for (const k of ["host.laptop.k1.bad", "laptop"]) expect(await s.verify(k)).toEqual({ error: "bad_key" });
    expect(await s.revoke("k9")).toEqual({ addr: "?" });
    expect(await s.verify("host.a.k9.any")).toEqual({ error: "bad_key" });
    expect((await s.list({ ids: ["k9", "k1"] })).map((p) => p.kid)).toEqual(["k1"]);
    expect(await s.list({ kind: "machine" })).toEqual([]);
    await s.setHosts(["win", "wsl"]);
    expect(await s.verify("win.k4.any")).toEqual({ kid: "k4", addr: "@win" });
    expect(await s.list({ kind: "machine" })).toEqual([
      { kid: "win", addr: "@win", owner: null, wait: false },
      { kid: "wsl", addr: "@wsl", owner: null, wait: false },
    ]);
    expect(await s.list({ kind: "device" })).toEqual([]);
    await s.setHosts([]);
  });
});
