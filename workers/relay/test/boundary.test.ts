// Леса границы «транслятор рации», среда Worker'а: настоящий объект машины в workerd, настоящий gate за переключателем, журнал — подделка.
// Вход — wss /m/<машина>, POST keys.revoke, привязка Relay.deliver. Исход — кадры, закрытия, факты в строках журнала платформы.
// Номер — эталон-источник; свойства без пометки — чьё: код. Карточка соединения (attachment) со словом ver — формат хранения, живущий при смене кода.
import { SELF, abortAllDurableObjects, applyD1Migrations, env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Peer, eventually, fleet, key, pass, wait } from "./peer.ts";

const OWNER = "owner@example.com";
/** адрес устройства владельца флота: пропуска клиентов выданы ему */
const dev = (n: string) => `${n}~${OWNER}`;

type F = Record<string, any>;
let logs: string[] = [];
let peers: Peer[] = [];

const sessions = (m: string, names: string[], extra: F = {}) => names.map((n) => ({ callsign: `${n}@${m}`, state: "idle", slot: "main", ...extra }));
async function hello(role: "host" | "keeper" | "client", name: string, extra: F = {}, kid?: string) {
  const p = await Peer.hello(role, name, extra, kid);
  peers.push(p);
  return p;
}
async function open(machine?: string) {
  const p = await Peer.open(machine);
  peers.push(p);
  return p;
}
/** Соединение с объектом машины и hello готовым пропуском; ждёт roster или закрытие. */
async function enter(machine: string, k: string, extra: F = {}) {
  const p = await Peer.enter(machine, k, extra);
  peers.push(p);
  return p;
}
const laptop = () => hello("host", "laptop", { sdk: "0.3.311", contract: { message: 1 }, sessions: sessions("laptop", ["site", "profiles", "wiki"], { account: "y0902" }) });
const pc = () => hello("host", "pc", { contract: { message: 1 }, sessions: sessions("pc", ["poe-bot", "api"], { account: "infirex" }) });
/** Строка журнала: начинается со слова, содержит факты. Формат строки контракт не обещает: журнал читают агенты, его смысл — слово, кто и почему. */
const logged = (word: string, ...facts: string[]) => logs.find((l) => l.startsWith(word) && facts.every((f) => l.includes(f)));
const callsigns = (r: F) => r.sessions.map((s: F) => s.callsign).sort();
const post = (body: F) => SELF.fetch("https://switchboard.test/", { method: "POST", body: JSON.stringify(body) });
const ledgerAdds = async () => (await env.LEDGER.received()).filter((f: F) => f.type === "ledger.add" && f.from === ".relay");
/** Соединения объекта приняты прежним кодом: версия в карточке другая; объект выгружен. */
async function oldCode(machine = "laptop") {
  await runInDurableObject(fleet(machine), async (_o, state) => {
    for (const ws of state.getWebSockets()) ws.serializeAttachment({ ...((ws.deserializeAttachment() as F) ?? {}), ver: "прежняя" });
  });
  await evictDurableObject(fleet(machine));
}
/** Платформа отдаёт соединения объекта через подмену: сбой внутри обработки кадра, сокет, до которого close не доходит. */
function swapSockets(machine: string, get: (real: DurableObjectState) => WebSocket[]) {
  return runInDurableObject(fleet(machine), (o) => {
    const x = o as unknown as { ctx: DurableObjectState };
    const real = x.ctx;
    x.ctx = new Proxy(real, {
      get(t, k) {
        if (k === "getWebSockets") return () => get(t);
        const v = Reflect.get(t, k);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
  });
}

beforeEach(async () => {
  await applyD1Migrations(env.GATE_DB, env.GATE_MIGRATIONS);
  await env.GATE_DB.exec("DELETE FROM passes");
  await env.LEDGER.setMode("ok");
  await env.LEDGER.clear();
  await env.GATE.setMode("real");
  await env.GATE.clear();
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
});
afterEach(async () => {
  for (const p of peers) p.close();
  peers = [];
  // объекты сняты раньше шпиона: их поздняя строка не уходит в закрытый канал журнала теста
  await abortAllDurableObjects();
  vi.restoreAllMocks();
});

describe("вход без состояния", () => {
  it("не wss — 426; wss не на машину — 404", async () => {
    expect((await SELF.fetch("https://switchboard.test/")).status).toBe(426);
    expect((await SELF.fetch("https://switchboard.test/m/laptop")).status).toBe(426);
    for (const path of ["/", "/m/", "/m/a/b", "/m/a b", "/x"]) {
      const res = await SELF.fetch(`https://switchboard.test${path}`, { headers: { Upgrade: "websocket" } });
      expect([path, res.status]).toEqual([path, 404]);
    }
  });

  it("ping → pong автоответом платформы", async () => {
    const a = await laptop();
    a.send("ping");
    await eventually(() => a.raw.includes("pong") || undefined);
  });

  it("5030 · объект win упал → гости и Host на объекте wsl работают", async () => {
    const phone = await pass("client", "phone");
    const win = await enter("win", (await pass("host", "win")).key);
    const wsl = await enter("wsl", (await pass("host", "wsl")).key, { sessions: sessions("wsl", ["api"]) });
    const onWsl = await enter("wsl", phone.key);
    await runInDurableObject(fleet("win"), (_o, s) => s.abort("стенд: объект win упал")).catch(() => {});
    await win.waitClose();
    onWsl.send({ type: "message", id: "w-1", to: "api@wsl" });
    expect(await wsl.next((f) => f.type === "message")).toMatchObject({ id: "w-1", from: dev("phone") });
    expect(wsl.closed ?? onWsl.closed).toBeNull();
  });
});

describe("hello", () => {
  it("1 · 5022 · объект laptop: свой Host — машина и её сессии с полями как прислал Host; Host pc — гость @pc, адрес устройства — из ответа gate", async () => {
    const a = await laptop();
    const b = await pc();
    const phone = await hello("client", "phone");
    for (const p of [a, b, phone]) {
      const r = await p.roster();
      expect(callsigns(r)).toEqual(["profiles@laptop", "site@laptop", "wiki@laptop"]);
      expect(r.machines).toEqual([{ machine: "laptop", since: expect.any(Number), proto: 1, sdk: "0.3.311", contract: { message: 1 } }]);
      expect(r.sessions.find((s: F) => s.callsign === "site@laptop").account).toBe("y0902");
      expect(r.clients.sort()).toEqual(["@pc", dev("phone")]);
    }
    expect(logged("hello", "k-laptop", "host", "3 сессий", "proto 1")).toBeDefined();
    expect(logged("hello", "k-pc", "guest", "proto 1")).toBeDefined();
    expect(logged("hello", "k-phone", "client", "proto 1")).toBeDefined();
    const named = await enter("win", (await pass("client", "win")).key);
    expect((await named.roster()).machines).toEqual([]);
  });

  it("47 · кадр до принятого hello и пока gate проверяет hello — закрыт 1008 bad_frame, кадр не доставлен", async () => {
    const a = await laptop();
    await env.GATE.clear();
    const x = await open();
    x.send({ type: "message", to: "site@laptop", text: "hi" });
    expect(await x.waitClose()).toEqual({ code: 1008, reason: "bad_frame" });
    expect(await env.GATE.calls()).toEqual([]);
    expect(logged("bad_frame", "до hello", "message")).toBeDefined();
    await env.GATE.setMode("slow");
    const y = await open();
    y.send({ type: "hello", proto: 1, key: await key("client", "phone") });
    await wait(50);
    y.send({ type: "message", to: "site@laptop" });
    expect(await y.waitClose()).toEqual({ code: 1008, reason: "bad_frame" });
    expect(await a.quiet()).toEqual([]);
  });

  it("133 · 30 · отозванный и чужой секрет — закрыт 1008 bad_key, слово gate как есть, секрета в журнале нет", async () => {
    const phone = await hello("client", "phone");
    const revoked = await open();
    revoked.send({ type: "hello", proto: 1, key: await key("client", "phone", "k2a9") });
    expect(await revoked.waitClose()).toEqual({ code: 1008, reason: "bad_key" });
    expect(logged("bad_key", "k2a9")).toBeDefined();
    const stranger = await open();
    const k = await key("host", "laptop", "k7f3", "чужой секрет");
    stranger.send({ type: "hello", proto: 1, key: k, sessions: sessions("laptop", ["site"]) });
    expect(await stranger.waitClose()).toEqual({ code: 1008, reason: "bad_key" });
    expect(logged("bad_key", "k7f3")).toBeDefined();
    expect(logs.join("\n")).not.toContain(k.split(".")[3]);
    expect(await phone.quiet()).toEqual([]);
  });

  it("открытая дверь: key объектом, который не приводится к строке, — 1008 bad_key, как чужой пропуск; Host машины на связи", async () => {
    // источник: устав — ошибка словом; слово пользователя 6 нояб. — вход без пропуска реален, отказ словом обязателен
    const a = await laptop();
    const x = await open();
    x.send({ type: "hello", proto: 1, key: { toString: 1 } });
    expect(await x.waitClose()).toEqual({ code: 1008, reason: "bad_key" });
    expect(await a.quiet()).toEqual([]);
    expect(a.closed).toBeNull();
  });

  it.each([
    // сбой под нагрузкой может опоздать за предел стенда: причина тогда — предел
    ["throw", "gate "],
    ["hang", "gate не ответил за 0.5 с"],
  ])("118 · 132 · 143 · gate не ответил (%s): закрыт 1008 gate_unavailable за предел вызова, причина в журнале без секрета; laptop на связи, roster не изменился", async (mode, why) => {
    // источник предела: слово пользователя 2 нояб. «у всех операций лимит»
    const a = await laptop();
    await a.roster();
    await env.GATE.setMode(mode);
    const phone = await open();
    const k = await key("client", "phone", "k8e1");
    phone.send({ type: "hello", proto: 1, key: k });
    expect(await phone.waitClose()).toEqual({ code: 1008, reason: "gate_unavailable" });
    expect(logged("gate", "k8e1", "gate_unavailable", why)).toBeDefined();
    expect(logs.join("\n")).not.toContain(k.split(".")[3]);
    expect(await a.quiet()).toEqual([]);
    expect(a.frames.filter((f) => f.type === "roster")).toEqual([]);
    expect(a.closed).toBeNull();
  });

  it.each([
    ["proto 2", { proto: 2 }, "contract_mismatch", "proto 2"],
    ["в hello сессия чужой машины", { sessions: [{ callsign: "wiki@pc" }] }, "bad_from", "callsign"],
    ["голое имя машины вместо сессии", { sessions: [{ callsign: "@laptop" }] }, "bad_from", "callsign"],
    ["часть не keeper", { part: "capture" }, "bad_frame", "capture"],
    ["часть объектом, который не приводится к строке", { part: { toString: 1 } }, "bad_frame", "toString"],
  ])("33 · 34 · hello Host машины: %s — закрыт, слово и причина в журнале; прежний Host не тронут, в roster не попал", async (_n, extra, word, why) => {
    const panel = await hello("client", "panel-desk");
    const x = await open();
    x.send({ type: "hello", proto: 1, key: await key("host", "laptop"), ...extra });
    expect(await x.waitClose()).toEqual({ code: 1008, reason: word });
    expect(logged(word, "k-laptop", why)).toBeDefined();
    expect((await panel.roster()).machines).toEqual([]);
  });

  it("5023 · part keeper с пропуском своей машины → keeper; на объекте чужой машины и пропуском клиента → bad_frame", async () => {
    const k = await pass("host", "win");
    const keeper = await enter("win", k.key, { part: "keeper" });
    expect(keeper.closed).toBeNull();
    const stranger = await enter("wsl", k.key, { part: "keeper" });
    expect(await stranger.waitClose()).toEqual({ code: 1008, reason: "bad_frame" });
    const client = await enter("win", (await pass("client", "phone")).key, { part: "keeper" });
    expect(await client.waitClose()).toEqual({ code: 1008, reason: "bad_frame" });
  });

  it("46 · 2045 · карточка больше 16 384 байт: hello закрыт, session.state отказан — bad_frame; в журнале размер и предел; прежний Host и запись не тронуты", async () => {
    const a = await laptop();
    const phone = await hello("client", "phone");
    await phone.roster();
    const big = await open();
    const s = sessions("laptop", Array.from({ length: 60 }, (_, i) => `s${i}`), { note: "x".repeat(260) });
    big.send({ type: "hello", proto: 1, key: await key("host", "laptop", "k9z9"), sessions: s });
    expect(await big.waitClose()).toEqual({ code: 1008, reason: "bad_frame" });
    expect(logged("bad_frame", "k9z9")).toMatch(/карточка \d+ байт · предел 16384/);
    a.send({ type: "session.state", id: "s-big", callsign: "site@laptop", state: "busy", note: "x".repeat(17_000) });
    expect(await a.next((f) => f.id === "s-big")).toMatchObject({ ok: false, error: "bad_frame" });
    expect(logged("bad_frame", "@laptop", "session.state")).toMatch(/карточка \d+ байт · предел 16384/);
    expect(await phone.quiet()).toEqual([]);
    a.send({ type: "session.state", callsign: "wiki@laptop", state: "busy" });
    expect((await phone.roster()).sessions.find((s: F) => s.callsign === "site@laptop").state).toBe("idle");
  });

  it("41 · новый hello той же машины закрывает прежнее соединение: 1000 replaced; сессии по разу, since новый, кадры — в новое", async () => {
    const old = await laptop();
    const panel = await hello("client", "panel-desk");
    const r1 = await panel.roster();
    await wait(5);
    const fresh = await laptop();
    expect(await old.waitClose()).toEqual({ code: 1000, reason: "replaced" });
    expect(logged("replaced", "k-laptop")).toBeDefined();
    const r2 = await eventually(async () => {
      const x = await panel.roster();
      return x.machines[0].since !== r1.machines[0].since ? x : undefined;
    });
    expect(r2.machines.length).toBe(1);
    expect(callsigns(r2)).toEqual(["profiles@laptop", "site@laptop", "wiki@laptop"]);
    panel.send({ type: "message", to: "site@laptop", text: "hi" });
    expect(await fresh.next((f) => f.type === "message")).toMatchObject({ from: dev("panel-desk") });
  });

  it("6101 · связь Host оборвалась молча: прежнее соединение не ответило на close и выглядит открытым — машина и сессии в roster по разу, кадры — в новое", async () => {
    const old = await laptop();
    const panel = await hello("client", "panel-desk");
    await panel.roster();
    await wait(5);
    // платформа после сна объекта снова показывает такой сокет открытым: close до него не доходит
    await swapSockets("laptop", (t) => {
      const all = t.getWebSockets();
      for (const s of all) s.close = () => {};
      return all;
    });
    const fresh = await hello("host", "laptop", { contract: { message: 1 }, sessions: sessions("laptop", ["site"]) });
    const r = await eventually(async () => {
      const y = await fresh.roster();
      return y.sessions.some((s: F) => s.callsign === "site@laptop") ? y : undefined;
    });
    expect(r.machines.length).toBe(1);
    expect(callsigns(r)).toEqual(["site@laptop"]);
    panel.send({ type: "message", to: "site@laptop", text: "hi" });
    expect(await fresh.next((f) => f.type === "message")).toMatchObject({ from: dev("panel-desk") });
    expect(await old.quiet()).toEqual([]);
  });
});

describe("кадр после hello: доставка по адресу", () => {
  it("3 · 2087 · 2047 · адресата нет — offline тому же id: чужая машина, сессия вне карточки, служба, часть не keeper, keeper не на связи, человек без устройств, ушедший спросивший; в журнале тип, отправитель, адрес, без текста", async () => {
    const a = await laptop();
    const phone = await hello("client", "phone");
    const refused = async (p: Peer, f: F) => expect(await (p.send(f), p.next((x) => x.type === "reply" && x.id === f.id))).toEqual({ type: "reply", id: f.id, ok: false, error: "offline" });
    await refused(phone, { type: "message", id: "m-4", to: "wiki@pc", text: "секретный текст" });
    expect(logged("offline", dev("phone"), "message", "wiki@pc")).toBeDefined();
    expect(logs.join("\n")).not.toContain("секретный текст");
    await refused(phone, { type: "message", id: "g-0", to: "ghost@laptop" });
    await refused(phone, { type: "ledger.add", id: "l-1", to: ".ledger" });
    await refused(phone, { type: "keeper.state", id: "h-1", to: ".host@laptop" });
    await refused(a, { type: "keeper.state", id: "k-2", to: ".keeper@laptop" });
    await refused(a, { type: "note", id: "n-1", to: "~stranger@example.com" });
    await refused(a, { type: "reply", id: "h-9", to: dev("panel-desk"), ok: true, result: {} });
    expect(await a.quiet()).toEqual([]);
  });

  it("6 · session.open с machine и незнакомый запрос с callsign — только Host этой машины, поле в поле плюс from; машины нет — offline; гостю — всё по адресам его машины: он знает свои сессии сам", async () => {
    const a = await laptop();
    const b = await pc();
    const panel = await hello("client", "panel-desk");
    const opening = { type: "session.open", id: "c-1", machine: "laptop", dir: "~/x", model: "opus" };
    const budget = { type: "budget.set", id: "b-1", v: 1, callsign: "site@laptop", limit_usd: 20 };
    panel.send(opening);
    panel.send(budget);
    expect(await a.next((f) => f.type === "session.open")).toEqual({ ...opening, from: dev("panel-desk") });
    expect(await a.next((f) => f.type === "budget.set")).toEqual({ ...budget, from: dev("panel-desk") });
    expect(await b.quiet()).toEqual([]);
    panel.send({ type: "session.dirs", id: "c-3", machine: "pc" });
    expect(await b.next((f) => f.type === "session.dirs")).toMatchObject({ id: "c-3", from: dev("panel-desk") });
    panel.send({ type: "message", id: "g-1", to: "ghost@pc" });
    expect(await b.next((f) => f.type === "message")).toMatchObject({ id: "g-1", to: "ghost@pc" });
    panel.send({ type: "session.open", id: "c-7", machine: "nas" });
    expect(await panel.next((f) => f.type === "reply")).toMatchObject({ id: "c-7", ok: false, error: "offline" });
    expect(logged("offline", dev("panel-desk"), "session.open", "nas")).toBeDefined();
  });

  it("Host без from — from @машина; to @машина доставляет Host этой машины; ответ доставляется по from обратно гостю", async () => {
    const a = await laptop();
    const b = await pc();
    a.send({ type: "machine.dirs", id: "d-1", to: "@pc" });
    expect(await b.next((f) => f.type === "machine.dirs")).toEqual({ type: "machine.dirs", id: "d-1", to: "@pc", from: "@laptop" });
    b.send({ type: "message", id: "g-1", from: "lead@pc", to: "site@laptop", text: "привет" });
    const got = await a.next((f) => f.type === "message");
    expect(got).toMatchObject({ from: "lead@pc", to: "site@laptop" });
    a.send({ type: "reply", id: "g-1", ok: true, to: got.from, from: "site@laptop" });
    expect(await b.next((f) => f.type === "reply")).toMatchObject({ id: "g-1", ok: true, from: "site@laptop" });
  });

  it("from своим адресом принят: клиент, keeper, Host; to важнее callsign; callsign и machine — Host машины без сверки с карточкой: о сессии знает он сам", async () => {
    const a = await laptop();
    const k = await hello("keeper", "laptop");
    const phone = await hello("client", "phone");
    phone.send({ type: "message", id: "e-1", from: dev("phone"), to: "site@laptop" });
    expect(await a.next((f) => f.id === "e-1")).toMatchObject({ from: dev("phone") });
    k.send({ type: "note", id: "e-2", from: ".keeper@laptop", to: "@laptop" });
    expect(await a.next((f) => f.id === "e-2")).toMatchObject({ from: ".keeper@laptop" });
    a.send({ type: "note", id: "e-3", from: "@laptop", to: ".keeper@laptop" });
    expect(await k.next((f) => f.id === "e-3")).toMatchObject({ from: "@laptop" });
    phone.send({ type: "x", id: "e-4", callsign: "ghost@laptop" });
    expect(await a.next((f) => f.id === "e-4")).toMatchObject({ callsign: "ghost@laptop" });
    phone.send({ type: "x", id: "e-5", to: "site@laptop", callsign: "wiki@pc" });
    expect(await a.next((f) => f.id === "e-5")).toMatchObject({ to: "site@laptop" });
  });

  it("45 · 7 · кадр со списком to — каждому, до кого дошёл адрес, одной копией, список целиком; никому — строка журнала, ответа нет", async () => {
    // источник одной копии: опыт на настоящем объекте: Host получал кадр по разу на адрес и исполнял его дважды
    const a = await laptop();
    const b = await pc();
    const k = await hello("keeper", "laptop");
    const phone = await hello("client", "phone");
    const panel = await hello("client", "panel-desk");
    const to = ["site@laptop", "wiki@laptop", "@laptop", "ghost@laptop", "x@pc", ".keeper@laptop", ".ledger", dev("phone"), "x@nas"];
    phone.send({ type: "q", to });
    for (const p of [a, b, k, phone]) expect(await p.next((f) => f.type === "q")).toEqual({ type: "q", to, from: dev("phone") });
    expect((await a.quiet()).filter((f) => f.type === "q")).toEqual([]);
    const q = { type: "question", from: "profiles@laptop", to: [dev("phone"), dev("panel-desk")], callsign: "profiles@laptop", question: "q-4", options: ["да", "нет"] };
    a.send(q);
    expect(await phone.next((f) => f.type === "question")).toEqual(q);
    expect(await panel.next((f) => f.type === "question")).toEqual(q);
    expect(await a.quiet()).toEqual([]);
    phone.send({ type: "q2", to: ["x@nas", ".ledger"] });
    await eventually(() => logged("offline", dev("phone"), "q2", "x@nas", ".ledger"));
    expect(await phone.quiet()).toEqual([]);
  });

  it("40 · клиент с двумя соединениями: roster перечисляет его один раз; объект засыпает; reply от Host с to panel-desk получают соединения panel-desk и только они", async () => {
    const a = await laptop();
    const panel = await hello("client", "panel-desk");
    const panel2 = await hello("client", "panel-desk");
    const phone = await hello("client", "phone");
    expect((await phone.roster()).clients.sort()).toEqual([dev("panel-desk"), dev("phone")]);
    panel.send({ type: "session.history", id: "h-3", callsign: "site@laptop" });
    expect(await a.next((f) => f.type === "session.history")).toMatchObject({ id: "h-3", from: dev("panel-desk") });
    await evictDurableObject(fleet());
    a.send({ type: "reply", id: "h-3", to: dev("panel-desk"), ok: true, result: { turns: [] } });
    const want = { type: "reply", id: "h-3", to: dev("panel-desk"), ok: true, result: { turns: [] }, from: "@laptop" };
    expect(await panel.next((f) => f.type === "reply")).toEqual(want);
    expect(await panel2.next((f) => f.type === "reply")).toEqual(want);
    expect(await phone.quiet()).toEqual([]);
  });

  it("5025 · устройство — гостям объекта с этим адресом; ~почта — всем устройствам человека на объекте", async () => {
    const win = await enter("win", (await pass("host", "win")).key);
    const phone = await enter("win", (await pass("client", "phone")).key);
    const pult = await enter("win", (await pass("client", "pult")).key);
    const other = await enter("win", (await pass("client", "phone", "other@example.com")).key);
    win.send({ type: "note", to: dev("phone"), text: "одному" });
    expect(await phone.next((f) => f.type === "note")).toMatchObject({ text: "одному", from: "@win" });
    win.send({ type: "note", to: "~" + OWNER, text: "всем" });
    expect(await phone.next((f) => f.type === "note")).toMatchObject({ text: "всем" });
    expect(await pult.next((f) => f.type === "note")).toMatchObject({ text: "всем" });
    expect(await other.quiet()).toEqual([]);
  });

  it("32 · 33 · from ставит relay: чужой from — bad_from, до адресата не дошёл", async () => {
    const a = await laptop();
    const b = await pc();
    const k = await hello("keeper", "laptop");
    const phone = await hello("client", "phone");
    phone.send({ type: "message", id: "m-8", from: "site@laptop", to: "poe-bot@pc", text: "…" });
    expect(await phone.next((f) => f.type === "reply")).toEqual({ type: "reply", id: "m-8", ok: false, error: "bad_from" });
    expect(logged("bad_from", dev("phone"), "message", "site@laptop")).toBeDefined();
    expect(await b.quiet()).toEqual([]);
    for (const [who, from] of [[a, "poe-bot@pc"], [a, ".keeper@laptop"], [b, "site@laptop"], [k, "@laptop"]] as Array<[Peer, string]>) {
      who.send({ type: "message", id: "m-1", from, to: dev("phone") });
      expect(await who.next((f) => f.type === "reply")).toEqual({ type: "reply", id: "m-1", ok: false, error: "bad_from" });
    }
    expect(phone.frames.find((f) => f.type === "message")).toBeUndefined();
  });

  it.each([
    ["to списком у кадра с id", { type: "question", id: "q", to: [dev("phone"), dev("panel-desk")] }, "списком"],
    ["в списке не адрес", { type: "question", to: [dev("phone"), "голое"] }, "голое"],
    ["голое имя", { type: "message", id: "q", to: "phone" }, "phone"],
    ["to объектом, который не приводится к строке", { type: "message", id: "q", to: { toString: 1 } }, "toString"],
    ["в списке объект, который не приводится к строке", { type: "question", to: [dev("phone"), { toString: 1 }] }, "toString"],
    ["нет адреса", { type: "message", id: "q" }, "нет адреса"],
    ["callsign без машины", { type: "budget.set", id: "q", callsign: "wiki", machine: "laptop" }, "wiki"],
    ["имя relay roster", { type: "roster", id: "q", machines: [] }, "имя relay"],
    ["имя relay hello", { type: "hello", id: "q", key: "x" }, "имя relay"],
  ])("2046 · %s — bad_frame: с id ответом, причина в журнале", async (_n, frame, why) => {
    const a = await laptop();
    a.send(frame);
    if ("id" in frame) expect(await a.next((f) => f.id === "q")).toEqual({ type: "reply", id: "q", ok: false, error: "bad_frame" });
    await eventually(() => logged("bad_frame", "@laptop", frame.type, why));
  });

  it("не JSON или без type — bad_frame: с id — reply, без id — только журнал", async () => {
    const a = await laptop();
    a.send('{"id":"x-1","to":"phone"}');
    expect(await a.next((f) => f.type === "reply")).toEqual({ type: "reply", id: "x-1", ok: false, error: "bad_frame" });
    a.send("не json");
    expect(await a.quiet()).toEqual([]);
    expect(logged("bad_frame", "laptop", "не кадр")).toBeDefined();
  });
});

describe("session.state и roster", () => {
  it("session.state заменяет запись целиком и с state null убирает; порядок записей держится; конверт в запись не идёт, ответа нет; чужой callsign и не от Host — bad_from", async () => {
    const a = await laptop();
    const guest = await pc();
    const phone = await hello("client", "phone");
    const k = await hello("keeper", "laptop");
    await phone.roster();
    a.send({ type: "session.state", id: "s-0", v: 1, to: ".relay", from: "@laptop", callsign: "site@laptop", state: "busy", slot: "b" });
    let r = await phone.roster();
    expect(a.frames.find((f) => f.id === "s-0")).toBeUndefined();
    expect(r.sessions.find((s: F) => s.callsign === "site@laptop")).toEqual({ callsign: "site@laptop", state: "busy", slot: "b" });
    expect(r.sessions.map((s: F) => s.callsign)).toEqual(["site@laptop", "profiles@laptop", "wiki@laptop"]);
    a.send({ type: "session.state", callsign: "wiki@laptop", state: null });
    r = await phone.roster();
    expect(callsigns(r)).toEqual(["profiles@laptop", "site@laptop"]);
    a.send({ type: "session.state", callsign: "new@laptop", state: "idle" });
    r = await phone.roster();
    expect(r.sessions.map((s: F) => s.callsign)).toEqual(["site@laptop", "profiles@laptop", "new@laptop"]);
    a.send({ type: "session.state", id: "s-1", callsign: "poe-bot@pc", state: "idle" });
    expect(await a.next((f) => f.id === "s-1")).toMatchObject({ error: "bad_from" });
    expect(logged("bad_from", "@laptop", "session.state", "poe-bot@pc")).toBeDefined();
    phone.send({ type: "session.state", id: "s-2", callsign: "x@phone", state: "idle" });
    expect(await phone.next((f) => f.id === "s-2")).toMatchObject({ error: "bad_from" });
    k.send({ type: "session.state", id: "s-3", callsign: "site@laptop", state: "idle" });
    expect(await k.next((f) => f.id === "s-3")).toMatchObject({ error: "bad_from" });
    guest.send({ type: "session.state", id: "s-4", callsign: "api@pc", state: "busy" });
    expect(await guest.next((f) => f.id === "s-4")).toMatchObject({ error: "bad_from" });
    expect(logged("bad_from", ".keeper@laptop", "session.state", "Host")).toBeDefined();
  });

  it("2 · соединение Host pc и laptop закрылось: roster разослан сразу, в журнале строка с кодом и причиной", async () => {
    const a = await laptop();
    const b = await pc();
    const phone = await hello("client", "phone");
    await a.roster();
    b.close();
    for (const p of [a, phone]) {
      const r = await eventually(async () => {
        const x = await p.roster();
        return x.clients.includes("@pc") ? undefined : x;
      });
      expect(r.machines.map((m: F) => m.machine)).toEqual(["laptop"]);
    }
    await eventually(() => logged("close", "pc", "1000 bye"));
    a.close(1000, "уход");
    const r = await eventually(async () => {
      const x = await phone.roster();
      return x.machines.length ? undefined : x;
    });
    expect(r.sessions).toEqual([]);
    expect(logged("close", "laptop", "1000 уход")).toBeDefined();
  });

  it("4 · объект выгружен, соединения открыты; session.state — roster тот же, что до сна, никто не переподключался", async () => {
    const a = await laptop();
    const b = await pc();
    const panel = await hello("client", "panel-desk");
    const before = await panel.roster();
    await evictDurableObject(fleet());
    a.send({ type: "session.state", callsign: "site@laptop", state: "idle", slot: "main", account: "y0902" });
    expect(await panel.roster()).toEqual(before);
    expect([a, b, panel].every((p) => p.closed === null)).toBe(true);
  });

  it("5028 · Host вошёл → журнал machine.back; ушёл → machine.left; гости журнал не пишут; выгрузка объекта вход не повторяет", async () => {
    const win = await enter("win", (await pass("host", "win")).key);
    await enter("win", (await pass("host", "wsl")).key);
    await enter("win", (await pass("client", "phone")).key);
    await eventually(async () => (await ledgerAdds()).length === 1);
    expect((await ledgerAdds())[0]).toEqual({ type: "ledger.add", v: 1, to: ".ledger", ev: "machine.back", machine: "win", from: ".relay" });
    await evictDurableObject(fleet("win"));
    await enter("win", (await pass("client", "pult")).key);
    win.close();
    await eventually(async () => (await ledgerAdds()).length === 2);
    expect((await ledgerAdds()).map((f: F) => [f.ev, f.machine])).toEqual([
      ["machine.back", "win"],
      ["machine.left", "win"],
    ]);
    expect(logs).toContain("machine.back win");
    expect(logs).toContain("machine.left win");
  });

  it("журнал по живой машине: вытеснение той же машины — ни ухода, ни нового входа; соединения прежнего кода и отзыв — уход", async () => {
    const adds = async () => (await ledgerAdds()).map((f: F) => [f.ev, f.machine]);
    const old = await laptop();
    await eventually(async () => (await adds()).length === 1);
    await laptop();
    await old.waitClose();
    await wait(100);
    expect(await adds()).toEqual([["machine.back", "laptop"]]);
    await oldCode();
    await hello("client", "panel-desk");
    await eventually(async () => (await adds()).length === 2);
    expect(await adds()).toEqual([["machine.back", "laptop"], ["machine.left", "laptop"]]);
    await env.LEDGER.clear();
    const agent = await pass("host", "win");
    const gone = await pass("host", "wsl");
    const own = await enter("wsl", gone.key);
    const watcher = await enter("wsl", agent.key);
    await post({ type: "keys.revoke", id: "r", v: 1, key: agent.key, kid: gone.kid });
    await own.waitClose();
    await eventually(async () => (await adds()).some(([ev]) => ev === "machine.left"));
    expect(await adds()).toEqual([["machine.back", "wsl"], ["machine.left", "wsl"]]);
    const r = await eventually(async () => {
      const x = await watcher.roster();
      return x.machines.length ? undefined : x;
    });
    expect(r.clients).toEqual(["@win"]);
  });

  it.each(["throw", "hang"])("журнал не ответил (%s): строка здесь, roster всем, Host на связи", async (mode) => {
    await env.LEDGER.setMode(mode);
    const win = await enter("win", (await pass("host", "win")).key, { sessions: sessions("win", ["site"]) });
    expect(callsigns(await win.roster())).toEqual(["site@win"]);
    expect(win.closed).toBeNull();
    // сбой под нагрузкой может опоздать за предел стенда: причина тогда — предел
    await eventually(() => logged("offline", ".ledger", "machine.back", "win", mode === "throw" ? "журнал" : "журнал не ответил за 0.5 с"));
  });
});

describe("keeper машины", () => {
  it("входит своим ключом: в roster его нет, roster он получает; кадр на .keeper@laptop — только ему, ответ — с from .keeper@; второй keeper вытесняет первого словом replaced", async () => {
    const a = await laptop();
    const k = await hello("keeper", "laptop");
    // keeper считает hello принятым только по первому кадру roster
    expect(k.frames[0].type).toBe("roster");
    const r = await a.roster();
    expect(r.machines.map((m: F) => m.machine)).toEqual(["laptop"]);
    expect(r.clients).toEqual([]);
    expect(logged("hello", "k-laptop", "keeper", "proto 1")).toBeDefined();
    const phone = await hello("client", "phone");
    phone.send({ type: "keeper.state", id: "k-1", to: ".keeper@laptop" });
    expect(await k.next((f) => f.type === "keeper.state")).toEqual({ type: "keeper.state", id: "k-1", to: ".keeper@laptop", from: dev("phone") });
    expect(a.frames.find((f) => f.type === "keeper.state")).toBeUndefined();
    k.send({ type: "reply", id: "k-1", to: dev("phone"), ok: true, result: { keeper: "1.1.60" } });
    expect(await phone.next((f) => f.type === "reply")).toEqual({ type: "reply", id: "k-1", to: dev("phone"), ok: true, result: { keeper: "1.1.60" }, from: ".keeper@laptop" });
    const k2 = await hello("keeper", "laptop");
    expect(await k.waitClose()).toEqual({ code: 1000, reason: "replaced" });
    a.send({ type: "keeper.state", id: "k-3", to: ".keeper@laptop" });
    expect(await k2.next((f) => f.type === "keeper.state")).toMatchObject({ id: "k-3", from: "@laptop" });
    expect(a.closed).toBeNull();
  });

  it("roster — только ему и один, при входе; его вход и уход флоту roster не рассылают, смены сессий keeper не получает", async () => {
    const a = await laptop();
    const phone = await hello("client", "phone");
    // очереди roster пусты до входа keeper; кадры дальше считаем, не забирая
    await a.roster();
    await phone.roster();
    const rosters = (p: { frames: F[] }) => p.frames.filter((f) => f.type === "roster").length;
    const k = await hello("keeper", "laptop");
    expect(rosters(k)).toBe(1);
    const has = (p: { frames: F[] }, state: string) => p.frames.find((f) => f.type === "roster" && f.sessions.some((x: F) => x.callsign === "site@laptop" && x.state === state));
    a.send({ type: "session.state", callsign: "site@laptop", state: "busy", slot: "main" });
    await phone.until(() => has(phone, "busy"), 3000, "roster busy");
    k.close();
    a.send({ type: "session.state", callsign: "site@laptop", state: "idle", slot: "main" });
    await phone.until(() => has(phone, "idle"), 3000, "roster idle");
    await a.until(() => has(a, "idle"), 3000, "roster idle у Host");
    // каждому — ровно две рассылки от смен сессии, ни одной от входа и ухода keeper
    expect([rosters(a), rosters(phone), rosters(k)]).toEqual([2, 2, 1]);
  });
});

describe("POST keys.revoke", () => {
  it("5027 · 5026 · gate отметил; соединения номера закрыты 1008 revoked на всех машинах; другие той же машины и человека живут; ответ — сколько закрыто", async () => {
    const agent = await pass("host", "win");
    await pass("host", "wsl");
    const phone = await pass("client", "phone");
    const host = await enter("win", agent.key);
    const pult = await enter("win", (await pass("client", "pult")).key);
    const onWin = await enter("win", phone.key);
    const onWsl = await enter("wsl", phone.key);
    const r = await post({ type: "keys.revoke", id: "r1", v: 1, key: agent.key, kid: phone.kid });
    expect(await r.json()).toEqual({ type: "reply", id: "r1", ok: true, result: { addr: dev("phone"), closed: 2 }, to: "@win" });
    expect(await onWin.waitClose()).toEqual({ code: 1008, reason: "revoked" });
    expect(await onWsl.waitClose()).toEqual({ code: 1008, reason: "revoked" });
    expect(logged("revoked", phone.kid)).toBeDefined();
    expect(logged("revoke ", phone.kid, dev("phone"), "@win", "2")).toBeDefined();
    expect(host.closed ?? pult.closed).toBeNull();
    expect((await pult.roster()).clients).toEqual([dev("pult")]);
    expect(await env.GATE_DB.prepare("SELECT state FROM passes WHERE id = ?").bind(phone.kid).first("state")).toBeNull();
    const again = await enter("win", phone.key);
    expect(await again.waitClose()).toEqual({ code: 1008, reason: "bad_key" });
  });

  it("7310 · отзыв пропуска машины закрывает и её собственные соединения: gate её больше не числит, объект — из адреса отозванного", async () => {
    // источник: живая проверка 4 нояб.: closed 4 на гостевых, Host и keeper самой машины остались на отозванном пропуске
    const agent = await pass("host", "win");
    const gone = await pass("host", "wsl");
    await enter("win", agent.key);
    const own = await enter("wsl", gone.key);
    const r = await post({ type: "keys.revoke", id: "r1", v: 1, key: agent.key, kid: gone.kid });
    expect(await r.json()).toMatchObject({ ok: true, result: { addr: "@wsl", closed: 1 } });
    expect(await own.waitClose()).toEqual({ code: 1008, reason: "revoked" });
  });

  it.each(["revoke-hang"])("gate подвёл на отзыве (%s) — failed за предел вызова и причина в журнале (слово пользователя 2 нояб.: у всех операций лимит)", async (mode) => {
    const agent = await pass("host", "win");
    const phone = await pass("client", "phone");
    await env.GATE.setMode(mode);
    const r = await post({ type: "keys.revoke", id: "r", v: 1, key: agent.key, kid: phone.kid });
    expect(await r.json()).toEqual({ type: "reply", id: "r", ok: false, error: "failed" });
    expect(logged("failed", "keys.revoke", "@win")).toBeDefined();
  });

  it.each([
    ["незнакомый номер", { type: "keys.revoke", id: "r", v: 1, kid: "zzzz" }, "unknown_key"],
    ["нет номера", { type: "keys.revoke", id: "r", v: 1 }, "bad_request"],
    ["другая версия", { type: "keys.revoke", id: "r", v: 2, kid: "zzzz" }, "contract_mismatch"],
  ])("%s — отказ словом, ответ тому, кто спросил", async (_n, frame, word) => {
    const agent = await pass("host", "win");
    expect(await (await post({ ...frame, key: agent.key })).json()).toEqual({ type: "reply", id: "r", ok: false, error: word, to: "@win" });
  });

  it("незнакомый номер — строка журнала; без пропуска — слово gate; без id — 204 без тела, номер не отозван", async () => {
    const agent = await pass("host", "win");
    await post({ type: "keys.revoke", id: "r3", v: 1, key: agent.key, kid: "zzzz" });
    expect(logged("unknown_key", "zzzz", "@win")).toBeDefined();
    expect(await (await post({ type: "keys.revoke", id: "r2", v: 1, kid: "x" })).json()).toMatchObject({ ok: false, error: "bad_key" });
    const phone = await pass("client", "phone");
    const r = await post({ type: "keys.revoke", v: 1, key: agent.key, kid: phone.kid });
    expect([r.status, await r.text()]).toEqual([204, ""]);
    expect(await env.GATE_DB.prepare("SELECT state FROM passes WHERE id = ?").bind(phone.kid).first("state")).toBe("ok");
  });
});

describe("привязка Relay.deliver", () => {
  const relay = () => (exports as unknown as { Relay: { deliver(f: F): Promise<number> } }).Relay;

  it("5029 · кадр к .keeper@win → keeper win, from вызывающего; keeper'а нет → 0 получателей; строка журнала", async () => {
    expect(await relay().deliver({ type: "keeper.plan", to: ".keeper@win", from: ".releases", rev: 7 })).toBe(0);
    expect(logged("offline", ".releases", ".keeper@win", "keeper.plan")).toBeDefined();
    const keeper = await enter("win", (await pass("host", "win")).key, { part: "keeper" });
    expect(await relay().deliver({ type: "keeper.plan", to: ".keeper@win", from: ".releases", rev: 8 })).toBe(1);
    expect(await keeper.next((f) => f.type === "keeper.plan")).toMatchObject({ rev: 8, from: ".releases" });
    expect(logged("deliver", ".releases", ".keeper@win", "keeper.plan")).toBeDefined();
  });

  it("адрес без машины — 0 получателей, объекты не будятся; сессии и машине — доставка; устройство — 0: у привязки нет объекта без машины", async () => {
    const win = await enter("win", (await pass("host", "win")).key, { sessions: sessions("win", ["site"]) });
    for (const to of [".ledger", dev("phone"), "~" + OWNER, undefined, ["@win"]]) expect(await relay().deliver({ type: "x", to, from: ".releases" })).toBe(0);
    expect(await relay().deliver({ type: "x", to: "site@win", from: ".releases" })).toBe(1);
    expect(await relay().deliver({ type: "x", to: "@win", from: ".releases" })).toBe(1);
    expect(await relay().deliver({ type: "x", to: "ghost@win", from: ".releases" })).toBe(0);
    await win.next((f) => f.to === "site@win");
    await win.next((f) => f.to === "@win");
  });
});

describe("новый код relay и сбой", () => {
  it("3124 · 3137 · 3139 · объект стартовал новым кодом — соединения прежнего кода и сокет без hello закрыты 1012 relay_updated и ушли из roster; вход новым кодом живёт; вернувшаяся машина — с новым since; тот же код после выгрузки никого не закрывает", async () => {
    // источник: устав «Остановкой Worker-модулей управляет Cloudflare: их ветка — соединение оборвалось → клиенты
    // переподключаются»; факт 2 нояб. — выпуск relay спящие сокеты не рвёт, кадр плана keeper@wsl и ответ releases.set потеряны
    const a = await laptop();
    const k = await hello("keeper", "laptop");
    const phone = await hello("client", "phone");
    const bare = await open();
    const since = (await a.roster()).machines[0].since;
    await wait(20);
    await oldCode();
    const panel = await hello("client", "panel-desk");
    for (const p of [a, k, phone, bare]) expect(await p.waitClose()).toEqual({ code: 1012, reason: "relay_updated" });
    expect(logged("relay_updated", "4")).toBeDefined();
    await panel.until(() => (panel.frames.some((f) => f.type === "roster" && !f.machines.length) ? true : undefined), 3000, "roster без laptop");
    await laptop();
    const r = await panel.next((f) => f.type === "roster" && f.machines.some((m: F) => m.machine === "laptop"));
    expect(r.machines[0].since).toBeGreaterThan(since);
    expect(callsigns(r)).toEqual(["profiles@laptop", "site@laptop", "wiki@laptop"]);
    await evictDurableObject(fleet());
    const pc2 = await pc();
    expect(panel.closed ?? pc2.closed).toBeNull();
  });

  it("3138 · кадр прежнего соединения будит объект — все прежние закрыты 1012 relay_updated, строки abort нет; следующий вход живёт", async () => {
    const a = await laptop();
    const phone = await hello("client", "phone");
    await oldCode();
    phone.send({ type: "session.history", v: 1, id: "h-1", callsign: "site@laptop" });
    for (const p of [a, phone]) expect(await p.waitClose()).toEqual({ code: 1012, reason: "relay_updated" });
    await wait(100);
    expect(logs.filter((l) => l.startsWith("abort"))).toEqual([]);
    const panel = await hello("client", "panel-desk");
    await wait(100);
    expect(panel.closed).toBeNull();
    expect(logs.filter((l) => l.startsWith("relay_updated"))).toHaveLength(1);
  });

  it("44 · ошибка в коде relay при кадре: журнал с причиной и типом, все соединения закрыты; после hello roster тот же", async () => {
    const a = await laptop();
    const panel = await hello("client", "panel-desk");
    const before = await panel.roster();
    // сбой внутри обработки кадра: платформа не отдаёт соединения объекта
    await swapSockets("laptop", () => {
      throw new TypeError("сбой в коде relay");
    });
    a.send({ type: "message", to: dev("panel-desk") });
    await a.waitClose();
    await panel.waitClose();
    expect(logged("abort", "сбой в коде relay", "message")).toBeDefined();
    await laptop();
    const panel2 = await hello("client", "panel-desk");
    const after = await panel2.roster();
    expect({ ...after, machines: after.machines.map((m: F) => ({ ...m, since: 0 })) }).toEqual({ ...before, machines: before.machines.map((m: F) => ({ ...m, since: 0 })) });
  });
});
