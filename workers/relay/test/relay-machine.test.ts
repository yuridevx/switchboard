// Эталоны relay 5021–5031: объект на машину. Пропуска нового вида — строки в базе gate стенда; gate — настоящий.
import { SELF, abortAllDurableObjects, applyD1Migrations, env, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { secret, sha256 } from "../../gate/src/key.ts";
import { Peer, eventually, wait } from "./peer.ts";

type F = Record<string, any>;
let logs: string[] = [];
let peers: Peer[] = [];
let n = 0;

/** Пропуск нового вида: строка «принят» в базе gate стенда. */
async function pass(role: "host" | "client", name: string, person?: string): Promise<{ key: string; kid: string }> {
  const kid = `p${String(++n).padStart(3, "0")}`;
  const code = secret();
  await env.GATE_DB.prepare("INSERT INTO passes (id, role, name, person, state, hash, by, at) VALUES (?, ?, ?, ?, 'ok', ?, 'test', ?)")
    .bind(kid, role, name, person ?? null, await sha256(code), Date.now())
    .run();
  return { key: `${role}.${name}.${kid}.${code}`, kid };
}

/** Соединение с объектом машины (или / — объект перехода) и hello; ждёт первый roster. */
async function enter(machine: string, key: string, extra: F = {}): Promise<Peer> {
  const res = await SELF.fetch(`https://switchboard.test/m/${machine}`, { headers: { Upgrade: "websocket" } });
  const ws = res.webSocket!;
  ws.accept();
  const p = new Peer(ws);
  peers.push(p);
  p.send({ type: "hello", proto: 1, key, ...extra });
  await p.until(() => p.frames.find((f) => f.type === "roster") ?? p.closed ?? undefined, 3000, "roster после hello");
  return p;
}

const sessions = (m: string, names: string[]) => names.map((s) => ({ callsign: `${s}@${m}`, state: "idle" }));
const obj = (m: string) => env.FLEET.get(env.FLEET.idFromName(`m/${m}`));
const ledgerAdds = async () => (await env.LEDGER.received()).filter((f: F) => f.type === "ledger.add" && f.from === ".relay");

beforeEach(async () => {
  await applyD1Migrations(env.GATE_DB, env.GATE_MIGRATIONS);
  await env.GATE_DB.exec("DELETE FROM passes");
  for (const c of [env.PUSH, env.LEDGER, env.AUDIT, env.ECHO]) {
    await c.setMode("ok");
    await c.clear();
  }
  await env.GATE.setMode("real");
  await env.GATE.clear();
  await abortAllDurableObjects();
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
});
afterEach(() => {
  for (const p of peers) p.close();
  peers = [];
  vi.restoreAllMocks();
});

describe("эталоны relay: объект на машину", () => {
  it("5021 · пропуск машины win на объекте win → свой Host: roster объекта — машина win и её сессии", async () => {
    const win = await enter("win", (await pass("host", "win")).key, { sessions: sessions("win", ["site", "wiki"]) });
    const r = await win.roster();
    expect(r.machines.map((m: F) => m.machine)).toEqual(["win"]);
    expect(r.sessions.map((s: F) => s.callsign)).toEqual(["site@win", "wiki@win"]);
    expect(r.clients).toEqual([]);
  });

  it("5022 · пропуск машины wsl на объекте win → гость @wsl; его кадр к сессии win доставлен, ответ — ему же", async () => {
    const win = await enter("win", (await pass("host", "win")).key, { sessions: sessions("win", ["site"]) });
    const guest = await enter("win", (await pass("host", "wsl")).key);
    expect((await win.roster()).clients).toEqual(["@wsl"]);
    expect((await guest.roster()).machines.map((m: F) => m.machine)).toEqual(["win"]);
    guest.send({ type: "message", id: "g-1", from: "lead@wsl", to: "site@win", text: "привет" });
    const got = await win.next((f) => f.type === "message");
    expect(got).toMatchObject({ from: "lead@wsl", to: "site@win" });
    win.send({ type: "reply", id: "g-1", ok: true, to: got.from, from: "site@win" });
    expect(await guest.next((f) => f.type === "reply")).toMatchObject({ id: "g-1", ok: true, from: "site@win" });
    // гость не говорит от имени чужой машины и не правит сессии объекта
    guest.send({ type: "message", id: "g-2", from: "site@win", to: "site@win" });
    expect(await guest.next((f) => f.type === "reply")).toMatchObject({ id: "g-2", error: "bad_from" });
    guest.send({ type: "session.state", id: "g-3", callsign: "lead@wsl", state: "busy" });
    expect(await guest.next((f) => f.type === "reply")).toMatchObject({ id: "g-3", error: "bad_from" });
  });

  it("5023 · part keeper с пропуском своей машины → keeper; на объекте чужой машины → bad_frame", async () => {
    const k = await pass("host", "win");
    const keeper = await enter("win", k.key, { part: "keeper" });
    expect(keeper.closed).toBeNull();
    const stranger = await enter("wsl", k.key, { part: "keeper" });
    expect(await stranger.waitClose()).toEqual({ code: 1008, reason: "bad_frame" });
  });

  it("5024 · кадр к сессии другой машины → offline: объект доставляет только своей машине и своим гостям", async () => {
    await enter("win", (await pass("host", "win")).key, { sessions: sessions("win", ["site"]) });
    await enter("wsl", (await pass("host", "wsl")).key, { sessions: sessions("wsl", ["api"]) });
    const phone = await enter("win", (await pass("client", "phone", "owner@example.com")).key);
    phone.send({ type: "message", id: "p-1", to: "api@wsl" });
    expect(await phone.next((f) => f.type === "reply")).toMatchObject({ id: "p-1", ok: false, error: "offline" });
  });

  it("5025 · кадр к устройству → гостям объекта с этим адресом; к ~почта — всем устройствам человека на объекте", async () => {
    const win = await enter("win", (await pass("host", "win")).key);
    const phone = await enter("win", (await pass("client", "phone", "owner@example.com")).key);
    const pult = await enter("win", (await pass("client", "pult", "owner@example.com")).key);
    const other = await enter("win", (await pass("client", "phone", "other@example.com")).key);
    win.send({ type: "note", to: "phone~owner@example.com", text: "одному" });
    expect(await phone.next((f) => f.type === "note")).toMatchObject({ text: "одному", from: "@win" });
    win.send({ type: "note", to: "~owner@example.com", text: "всем" });
    expect(await phone.next((f) => f.type === "note")).toMatchObject({ text: "всем" });
    expect(await pult.next((f) => f.type === "note")).toMatchObject({ text: "всем" });
    expect(await other.quiet()).toEqual([]);
  });

  it("5026 · close(номер) → соединения номера закрыты 1008 revoked; другие той же машины или человека живут", async () => {
    const phone = await pass("client", "phone", "owner@example.com");
    const host = await enter("win", (await pass("host", "win")).key);
    const a = await enter("win", phone.key);
    const pult = await enter("win", (await pass("client", "pult", "owner@example.com")).key);
    expect(await obj("win").close(phone.kid)).toBe(1);
    expect(await a.waitClose()).toEqual({ code: 1008, reason: "revoked" });
    expect(host.closed ?? pult.closed).toBeNull();
    expect((await pult.roster()).clients).toEqual(["pult~owner@example.com"]);
  });

  it("5027 · вход relay keys.revoke → gate отметил; close на объектах всех машин из списка gate; ответ — сколько закрыто", async () => {
    const agent = await pass("host", "win");
    await pass("host", "wsl");
    const phone = await pass("client", "phone", "owner@example.com");
    await enter("win", agent.key);
    const onWin = await enter("win", phone.key);
    const onWsl = await enter("wsl", phone.key);
    const r = await SELF.fetch("https://switchboard.test/", { method: "POST", body: JSON.stringify({ type: "keys.revoke", id: "r1", v: 1, key: agent.key, kid: phone.kid }) });
    expect(await r.json()).toEqual({ type: "reply", id: "r1", ok: true, result: { addr: "phone~owner@example.com", closed: 2 } });
    expect(await onWin.waitClose()).toEqual({ code: 1008, reason: "revoked" });
    expect(await onWsl.waitClose()).toEqual({ code: 1008, reason: "revoked" });
    expect(await env.GATE_DB.prepare("SELECT state FROM passes WHERE id = ?").bind(phone.kid).first("state")).toBe("revoked");
    const again = await enter("win", phone.key);
    expect(await again.waitClose()).toEqual({ code: 1008, reason: "revoked" });
    // без пропуска — слово gate; незнакомый номер — unknown_key
    const bad = await SELF.fetch("https://switchboard.test/", { method: "POST", body: JSON.stringify({ type: "keys.revoke", id: "r2", v: 1, kid: phone.kid }) });
    expect(await bad.json()).toMatchObject({ ok: false, error: "bad_key" });
    const none = await SELF.fetch("https://switchboard.test/", { method: "POST", body: JSON.stringify({ type: "keys.revoke", id: "r3", v: 1, key: agent.key, kid: "zzzz" }) });
    expect(await none.json()).toMatchObject({ ok: false, error: "unknown_key" });
  });

  it("5028 · Host вошёл → журнал machine.back; ушёл → machine.left; гости журнал не пишут", async () => {
    const win = await enter("win", (await pass("host", "win")).key);
    await enter("win", (await pass("host", "wsl")).key);
    await enter("win", (await pass("client", "phone", "owner@example.com")).key);
    await eventually(async () => (await ledgerAdds()).length === 1);
    win.close();
    await eventually(async () => (await ledgerAdds()).length === 2);
    expect((await ledgerAdds()).map((f: F) => [f.ev, f.machine])).toEqual([
      ["machine.back", "win"],
      ["machine.left", "win"],
    ]);
  });

  it("5029 · deliver(кадр к .keeper@win) → keeper win; keeper'а нет → offline (0 получателей)", async () => {
    const relay = (exports as unknown as { Relay: { deliver(f: F): Promise<number> } }).Relay;
    expect(await relay.deliver({ type: "keeper.plan", to: ".keeper@win", from: ".releases", rev: 7 })).toBe(0);
    const keeper = await enter("win", (await pass("host", "win")).key, { part: "keeper" });
    expect(await relay.deliver({ type: "keeper.plan", to: ".keeper@win", from: ".releases", rev: 8 })).toBe(1);
    expect(await keeper.next((f) => f.type === "keeper.plan")).toMatchObject({ rev: 8, from: ".releases" });
  });

  it("5030 · стенд: объект win упал → гости и Host на объекте wsl работают", async () => {
    const phone = await pass("client", "phone", "owner@example.com");
    const win = await enter("win", (await pass("host", "win")).key);
    const wsl = await enter("wsl", (await pass("host", "wsl")).key, { sessions: sessions("wsl", ["api"]) });
    const onWsl = await enter("wsl", phone.key);
    await runInDurableObject(obj("win"), (_o, s) => s.abort("стенд: объект win упал")).catch(() => {});
    await win.waitClose();
    onWsl.send({ type: "message", id: "w-1", to: "api@wsl" });
    expect(await wsl.next((f) => f.type === "message")).toMatchObject({ id: "w-1", from: "phone~owner@example.com" });
    expect(wsl.closed ?? onWsl.closed).toBeNull();
  });

  it("5031 · адрес соединения — из ответа gate; настройки владельца у relay нет", async () => {
    expect((env as unknown as Record<string, unknown>).OWNER).toBeUndefined();
    const win = await enter("win", (await pass("host", "win")).key);
    await enter("win", (await pass("client", "ci", "dev@example.com")).key);
    expect((await win.roster()).clients).toEqual(["ci~dev@example.com"]);
    await wait(10);
  });
});
