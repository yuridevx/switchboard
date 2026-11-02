// Эталоны gate 5001–5014 над базой D1 стенда; переход — старые ключи подписью секрета теста (111–114, 117).
import { exports, env as rawEnv } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GateApi, Pass } from "../contract.ts";
import worker from "../src/index.ts";
import { verify, type Env } from "../src/pass.ts";
import { seed } from "../src/seed.ts";

/** Старый ключ подписью, как его выдавал прежний invite.ts: проверка подписью живёт до снятия (вторая половина шага 5). */
async function sign(secret: string, role: "host" | "client", name: string, kid: string): Promise<string> {
  const id = `${role}.${name}.${kid}`;
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(id)));
  return `${id}.${btoa(String.fromCharCode(...sig)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}
import config from "../wrangler.jsonc?raw";

type TestEnv = Env & { PROD: D1Database; TEST_MIGRATIONS: D1Migration[] };
const env = rawEnv as unknown as TestEnv;
const SECRET = "test-secret";
const gate = (exports as unknown as { Gate: GateApi }).Gate;
let logs: string[] = [];
let n = 0;

/** POST по адресу gate: кадр → reply. */
async function post(f: Record<string, unknown>, e: Env = env): Promise<{ ok: boolean; result?: any; error?: string }> {
  const r = await worker.fetch(new Request("https://gate/", { method: "POST", body: JSON.stringify({ id: String(++n), v: 1, ...f }) }), e);
  return r.json();
}

/** Пропуск машины-выдающего: строка «принят» через seed и redeem. */
async function agent(): Promise<string> {
  const s = (await seed("host", `agent${++n}`))!;
  await env.DB.exec(s.sql);
  return (await post({ type: "gate.redeem", invite: s.invite })).result.key;
}

const rows = async () => (await env.DB.prepare("SELECT * FROM passes").all<Record<string, unknown>>()).results;

beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await applyD1Migrations(env.PROD, env.TEST_MIGRATIONS);
  await env.DB.exec("DELETE FROM passes");
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
});
afterEach(() => vi.restoreAllMocks());

describe("эталоны gate: пропуска в базе D1", () => {
  it("5001 · invite → строка «ждёт приёма» с хэшем; redeem → пропуск, строка «принят»; второй redeem того же приглашения → bad_invite", async () => {
    const by = await agent();
    const inv = await post({ type: "keys.invite", key: by, role: "client", name: "phone", person: "owner@example.com" });
    expect(inv.ok).toBe(true);
    expect(inv.result.invite).toMatch(/^[a-z0-9]{4}\.[A-Za-z0-9_-]{43}$/);
    const row = await env.DB.prepare("SELECT state, hash, by FROM passes WHERE id = ?").bind(inv.result.kid).first();
    expect(row).toMatchObject({ state: "wait", by: expect.stringMatching(/^@agent/) });
    const r1 = await post({ type: "gate.redeem", invite: inv.result.invite });
    expect(r1.result.key).toMatch(new RegExp(`^client\\.phone\\.${inv.result.kid}\\.[A-Za-z0-9_-]{43}$`));
    expect(await env.DB.prepare("SELECT state FROM passes WHERE id = ?").bind(inv.result.kid).first("state")).toBe("ok");
    expect(await post({ type: "gate.redeem", invite: inv.result.invite })).toMatchObject({ ok: false, error: "bad_invite" });
  });

  it("5002 · revoke строки «ждёт приёма» → redeem получает bad_invite", async () => {
    const inv = await post({ type: "keys.invite", key: await agent(), role: "host", name: "laptop" });
    expect(await gate.revoke(inv.result.kid)).toEqual({ addr: "@laptop" });
    expect(await post({ type: "gate.redeem", invite: inv.result.invite })).toMatchObject({ ok: false, error: "bad_invite" });
  });

  it("5003 · verify: строка есть, хэш сошёлся → роль, имя, номер и адрес; строка не меняется; задержка — в журнале", async () => {
    const inv = await post({ type: "keys.invite", key: await agent(), role: "host", name: "laptop" });
    const { key } = (await post({ type: "gate.redeem", invite: inv.result.invite })).result;
    const before = await rows();
    expect(await gate.verify(key)).toEqual({ role: "host", name: "laptop", kid: inv.result.kid, addr: "@laptop" });
    expect(await rows()).toEqual(before);
    expect(logs).toContainEqual(expect.stringMatching(new RegExp(`^ok host\\.laptop\\.${inv.result.kid} → @laptop · \\d+ мс$`)));
  });

  it("5004 · verify: секрет не тот → bad_key; строка «отозван» → revoked", async () => {
    const inv = await post({ type: "keys.invite", key: await agent(), role: "host", name: "laptop" });
    const { key } = (await post({ type: "gate.redeem", invite: inv.result.invite })).result;
    const other = key.slice(0, key.lastIndexOf(".") + 1) + "A".repeat(43);
    expect(await gate.verify(other)).toEqual({ error: "bad_key" });
    await gate.revoke(inv.result.kid);
    expect(await gate.verify(key)).toEqual({ error: "revoked" });
  });

  it("5005 · verify: роль или имя в пропуске не как в строке базы → bad_key", async () => {
    const inv = await post({ type: "keys.invite", key: await agent(), role: "client", name: "phone", person: "owner@example.com" });
    const { key } = (await post({ type: "gate.redeem", invite: inv.result.invite })).result;
    const [, , kid, sec] = key.split(".");
    expect(await gate.verify(`host.phone.${kid}.${sec}`)).toEqual({ error: "bad_key" });
    expect(await gate.verify(`client.laptop.${kid}.${sec}`)).toEqual({ error: "bad_key" });
    expect(await gate.verify(key)).toMatchObject({ addr: "phone~owner@example.com" });
  });

  it("5006 · в базе нет секретов: после invite и redeem — только хэши", async () => {
    const inv = await post({ type: "keys.invite", key: await agent(), role: "client", name: "phone", person: "owner@example.com" });
    const { key } = (await post({ type: "gate.redeem", invite: inv.result.invite })).result;
    const dump = JSON.stringify(await rows());
    expect(dump).not.toContain(inv.result.invite.split(".")[1]);
    expect(dump).not.toContain(key.split(".")[3]);
    expect((await rows()).every((r) => /^[0-9a-f]{64}$/.test(String(r.hash)))).toBe(true);
  });

  it("5007 · адрес вычисляет база: устройство → phone~почта; машина → @laptop", async () => {
    const by = await agent();
    expect((await post({ type: "keys.invite", key: by, role: "client", name: "phone", person: "owner@example.com" })).result.addr).toBe("phone~owner@example.com");
    expect((await post({ type: "keys.invite", key: by, role: "host", name: "laptop" })).result.addr).toBe("@laptop");
  });

  it("5008 · invite на адрес с живым пропуском → name_taken; после revoke прежнего — проходит", async () => {
    const by = await agent();
    const a = await post({ type: "keys.invite", key: by, role: "client", name: "phone", person: "owner@example.com" });
    expect(await post({ type: "keys.invite", key: by, role: "client", name: "phone", person: "owner@example.com" })).toMatchObject({ ok: false, error: "name_taken" });
    // другой человек — другой адрес
    expect((await post({ type: "keys.invite", key: by, role: "client", name: "phone", person: "other@example.com" })).ok).toBe(true);
    await gate.revoke(a.result.kid);
    expect((await post({ type: "keys.invite", key: by, role: "client", name: "phone", person: "owner@example.com" })).ok).toBe(true);
  });

  it("5009 · пропуск тестового флота в базе прода → bad_key", async () => {
    const inv = await post({ type: "keys.invite", key: await agent(), role: "host", name: "laptop" });
    const { key } = (await post({ type: "gate.redeem", invite: inv.result.invite })).result;
    expect(await verify({ DB: env.PROD }, key, () => {})).toEqual({ error: "bad_key" });
  });

  it("5010 · переход: старый ключ с подписью → адрес имя~владелец из настройки gate; после снятия секрета → bad_key", async () => {
    const old = await sign(SECRET, "client", "phone", "k8e1");
    expect(await gate.verify(old)).toEqual({ role: "client", name: "phone", kid: "k8e1", addr: "phone~yuridevx@gmail.com" });
    expect(await gate.verify(await sign(SECRET, "host", "laptop", "k7f3"))).toMatchObject({ addr: "@laptop" });
    expect(await verify({ DB: env.DB, OWNER: "yuridevx@gmail.com" }, old, () => {})).toEqual({ error: "bad_key" });
  });

  it("5011 · revoked(номера) → отозванные из них; живые и незнакомые не попадают; старые ключи — по списку перехода", async () => {
    const by = await agent();
    const a = await post({ type: "keys.invite", key: by, role: "host", name: "a" });
    const b = await post({ type: "keys.invite", key: by, role: "host", name: "b" });
    await gate.revoke(a.result.kid);
    expect(await gate.revoked([a.result.kid, b.result.kid, "zzzz", "client.phone.k2a9", "client.phone.k8e1", `host.a.${a.result.kid}`])).toEqual([
      a.result.kid,
      "client.phone.k2a9",
      `host.a.${a.result.kid}`,
    ]);
    expect(await gate.revoked([])).toEqual([]);
    expect(await gate.revoke("nope")).toEqual({ error: "unknown_key" });
  });

  it("5012 · keys.list с ролью host → машины флота: только строки «принят»; без роли — все, без хэшей", async () => {
    const by = await agent();
    await post({ type: "keys.invite", key: by, role: "host", name: "wait-machine" });
    const gone = await post({ type: "keys.invite", key: by, role: "host", name: "gone" });
    await post({ type: "gate.redeem", invite: gone.result.invite });
    await gate.revoke(gone.result.kid);
    await post({ type: "keys.invite", key: by, role: "client", name: "phone", person: "owner@example.com" });
    const hosts: Pass[] = (await post({ type: "keys.list", key: by, role: "host" })).result.passes;
    expect(hosts.map((p) => p.addr)).toEqual([expect.stringMatching(/^@agent/)]);
    const all: Pass[] = (await post({ type: "keys.list", key: by })).result.passes;
    expect(all.map((p) => p.state).sort()).toEqual(["ok", "revoked", "wait", "wait"]);
    expect(JSON.stringify(all)).not.toContain("hash");
    // привязка list — то же: машины флота для входа relay
    expect((await gate.list("host")).map((p) => p.addr)).toEqual(hosts.map((p) => p.addr));
  });

  it("5013 · seed → инструкция вставки; после неё в базе стенда redeem проходит", async () => {
    const s = (await seed("host", "first"))!;
    expect(s.sql).not.toContain(s.invite.split(".")[1]);
    await env.DB.exec(s.sql);
    expect((await post({ type: "gate.redeem", invite: s.invite })).result.key).toMatch(/^host\.first\./);
  });

  it("5014 · база не ответила → verify бросает; POST отвечает gate_unavailable", async () => {
    const down = { prepare() { throw new Error("D1_ERROR: недоступна"); } } as unknown as D1Database;
    const key = `host.laptop.k7f3.${"A".repeat(43)}`;
    await expect(verify({ DB: down }, key, () => {})).rejects.toThrow("недоступна");
    expect(await post({ type: "keys.list", key }, { DB: down })).toMatchObject({ ok: false, error: "gate_unavailable" });
  });
});

describe("вход gate: запросы и отказы", () => {
  it("keys.invite и keys.list без пропуска или с плохим → bad_key; поля не того вида → bad_request; без v → contract_mismatch", async () => {
    expect(await post({ type: "keys.list" })).toMatchObject({ error: "bad_key" });
    const by = await agent();
    expect(await post({ type: "keys.invite", key: by, role: "admin", name: "x" })).toMatchObject({ error: "bad_request" });
    expect(await post({ type: "keys.invite", key: by, role: "client", name: "phone" })).toMatchObject({ error: "bad_request" });
    expect(await post({ type: "keys.invite", key: by, role: "host", name: "lap.top" })).toMatchObject({ error: "bad_request" });
    expect(await post({ type: "keys.list", key: by, v: undefined })).toMatchObject({ error: "contract_mismatch" });
    expect(await post({ type: "gate.redeem", invite: "nope" })).toMatchObject({ error: "bad_invite" });
  });

  it("не POST → 404 без тела; ответ читается с любого адреса", async () => {
    const r = await worker.fetch(new Request("https://gate/"), env);
    expect(r.status).toBe(404);
    expect(await r.text()).toBe("");
    const p = await worker.fetch(new Request("https://gate/", { method: "POST", body: "{}" }), env);
    expect(p.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("конфиг выпуска: адрес workers.dev, база D1 в обоих окружениях, секретов в настройке нет", () => {
    const c = JSON.parse(config.replace(/^\s*\/\/.*$/gm, ""));
    expect(c.name).toBe("switchboard-gate");
    expect(c.workers_dev).toBe(true);
    expect(c.d1_databases[0]).toMatchObject({ binding: "DB", database_name: "switchboard-gate" });
    expect(c.env.prod.d1_databases[0]).toMatchObject({ binding: "DB", database_name: "switchboard-gate-prod" });
    expect(c.vars?.FLEET_SECRET).toBeUndefined();
  });
});

describe("переход: старые ключи подписью", () => {
  it("111 · верный ключ host.laptop.k7f3 — роль, имя, номер, адрес; в журнале ok", async () => {
    expect(await gate.verify(await sign(SECRET, "host", "laptop", "k7f3"))).toEqual({ role: "host", name: "laptop", kid: "k7f3", addr: "@laptop" });
    expect(logs).toContain("ok host.laptop.k7f3");
  });

  it("112 · ключ, подписанный другим секретом, — bad_key; подписи в журнале нет", async () => {
    const key = await sign("другой-секрет", "host", "laptop", "k7f3");
    expect(await gate.verify(key)).toEqual({ error: "bad_key" });
    expect(logs.join("\n")).not.toContain(key.split(".")[3]);
  });

  it("113 · отозванный client.phone.k2a9 — revoked; k8e1 тем же секретом проходит", async () => {
    expect(await gate.verify(await sign(SECRET, "client", "phone", "k2a9"))).toEqual({ error: "revoked" });
    expect(await gate.verify(await sign(SECRET, "client", "phone", "k8e1"))).toMatchObject({ kid: "k8e1" });
  });

  it("114 · пропуск не того вида — bad_key без исключения", async () => {
    for (const k of ["laptop-key", "admin.laptop.k7f3.Jx9w", undefined, "host.laptop.k7f3", "host..k7f3.sig", 42]) {
      expect(await gate.verify(k as string)).toEqual({ error: "bad_key" });
    }
  });

describe("один способ выдачи", () => {
  it("5184 · старого ключа подписью выдать нечем: в коде gate нет sign, у пакета нет bin switchboard-invite; проверка старых ключей жива", async () => {
    // источник: отчёт слепого архитектора 2 нояб.: п. 3 — два способа выдать пропуск
    const key = await import("../src/key.ts");
    expect(Object.keys(key)).not.toContain("sign");
    const pkg = (await import("../package.json", { with: { type: "json" } })).default as { bin?: Record<string, string> };
    expect(Object.keys(pkg.bin ?? {})).toEqual(["switchboard-seed", "switchboard-redeem"]);
    expect(Object.keys(key)).toContain("verifyKey");
  });
});
});
