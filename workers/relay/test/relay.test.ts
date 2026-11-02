// Эталоны relay и экосистемы (часть relay) на настоящем объекте флота в workerd.
// gate — настоящий, по привязке; участники push, ledger, audit, echo — поддельные Worker.
import { SELF, abortAllDurableObjects, applyD1Migrations, env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const OWNER = "owner@example.com";
/** адрес устройства владельца флота: ключи клиентов выданы ему */
const dev = (n: string) => `${n}~${OWNER}`;
import { Peer, eventually, fleet, key, wait } from "./peer.ts";

type F = Record<string, any>;
let logs: string[] = [];
let peers: Peer[] = [];

const sessions = (m: string, names: string[], extra: F = {}) => names.map((n) => ({ callsign: `${n}@${m}`, state: "idle", slot: "main", ...extra }));
async function hello(role: "host" | "keeper" | "client", name: string, extra: F = {}, kid?: string) {
  const p = await Peer.hello(role, name, extra, kid);
  peers.push(p);
  return p;
}
async function open() {
  const p = await Peer.open();
  peers.push(p);
  return p;
}
const laptop = () => hello("host", "laptop", { sdk: "0.3.311", contract: { message: 1 }, sessions: sessions("laptop", ["site", "profiles", "wiki"], { account: "y0902" }) });
const pc = () => hello("host", "pc", { contract: { message: 1 }, sessions: sessions("pc", ["poe-bot", "api"], { account: "infirex" }) });
const logHas = (s: string) => logs.some((l) => l.includes(s));
const callsigns = (r: F) => r.sessions.map((s: F) => s.callsign).sort();

beforeEach(async () => {
  await applyD1Migrations(env.GATE_DB, env.GATE_MIGRATIONS);
  for (const c of [env.LEDGER]) {
    await c.setMode("ok");
    await c.clear();
  }
  await env.GATE.setMode("real");
  await env.GATE.clear();
  await abortAllDurableObjects();
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
});
afterEach(async () => {
  for (const p of peers) p.close();
  peers = [];
  vi.restoreAllMocks();
});

describe("эталоны relay", () => {
  it("1 · объект laptop: свой Host — машина и её сессии с полями аккаунта как прислал Host; Host pc — гость @pc", async () => {
    const a = await laptop();
    const b = await pc();
    const phone = await hello("client", "phone");
    for (const p of [a, b, phone]) {
      const r = await p.roster();
      expect(callsigns(r)).toEqual(["profiles@laptop", "site@laptop", "wiki@laptop"]);
      expect(r.machines.map((m: F) => m.machine)).toEqual(["laptop"]);
      expect(r.sessions.find((s: F) => s.callsign === "site@laptop").account).toBe("y0902");
      expect(r.clients.sort()).toEqual(["@pc", dev("phone")]);
    }
  });

  it("2 · соединение Host pc закрылось: ни у кого нет машины pc и *@pc, roster разослан сразу", async () => {
    const a = await laptop();
    const b = await pc();
    const phone = await hello("client", "phone");
    await a.roster();
    b.close();
    for (const p of [a, phone]) {
      const r = await eventually(async () => {
        const x = await p.roster();
        return x.machines.length === 1 ? x : undefined;
      });
      expect(r.machines.map((m: F) => m.machine)).toEqual(["laptop"]);
      expect(callsigns(r).some((c: string) => c.endsWith("@pc"))).toBe(false);
    }
  });

  it("3 · message с id m-4 для wiki@pc: машины pc у объекта нет — сразу offline; в журнале тип, отправитель, адрес, без текста", async () => {
    await laptop();
    const phone = await hello("client", "phone");
    phone.send({ type: "message", id: "m-4", to: "wiki@pc", text: "секретный текст" });
    expect(await phone.next((f) => f.type === "reply")).toEqual({ type: "reply", id: "m-4", ok: false, error: "offline" });
    const line = logs.find((l) => l.startsWith("offline"))!;
    expect(line).toContain("phone");
    expect(line).toContain("message");
    expect(line).toContain("wiki@pc");
    expect(logs.join("\n")).not.toContain("секретный текст");
  });

  it("4 · объект выгружен, соединения открыты; session.state от laptop — roster тот же, что до сна, никто не переподключался", async () => {
    const a = await laptop();
    const b = await pc();
    const panel = await hello("client", "panel-desk");
    const before = await panel.roster();
    await evictDurableObject(fleet());
    a.send({ type: "session.state", callsign: "site@laptop", state: "idle", slot: "main", account: "y0902" });
    const after = await panel.roster();
    expect(after).toEqual(before);
    expect([a, b, panel].every((p) => p.closed === null)).toBe(true);
  });

  it("3124 · объект стартовал новым кодом relay — соединения, принятые прежним кодом, закрыты 1012 relay_updated (клиенты переподключаются); вход новым кодом живёт", async () => {
    // источник: устав «Остановкой Worker-модулей управляет Cloudflare: их ветка — соединение оборвалось → клиенты
    // переподключаются»; факт 2 нояб. — выпуск relay спящие сокеты не рвёт, кадр плана keeper@wsl и ответ releases.set потеряны
    const a = await laptop();
    const k = await hello("keeper", "laptop");
    const phone = await hello("client", "phone");
    await runInDurableObject(fleet(), async (_o, state) => {
      for (const ws of state.getWebSockets()) ws.serializeAttachment({ ...(ws.deserializeAttachment() as F), ver: "прежняя" });
    });
    await evictDurableObject(fleet());
    const panel = await hello("client", "panel-desk");
    for (const p of [a, k, phone]) expect(await p.waitClose()).toEqual({ code: 1012, reason: "relay_updated" });
    expect(logHas("relay_updated · закрыто соединений прежнего кода relay: 3")).toBe(true);
    expect(panel.closed).toBeNull();
    expect((await panel.roster()).clients).toContain(dev("panel-desk"));
    // тот же код после выгрузки — никого не закрывает
    await evictDurableObject(fleet());
    const pc2 = await pc();
    expect(panel.closed).toBeNull();
    expect(pc2.closed).toBeNull();
  });

  it("3137 · сокет прежнего кода без принятого hello — закрыт 1012 relay_updated при старте объекта, вход новым кодом живёт", async () => {
    // источник: слово пользователя 2 нояб. «у всех операций должен быть лимит»; факт — кадры при смене кода теряются молча, hello тоже
    const bare = await open();
    await wait(20);
    await runInDurableObject(fleet(), async (_o, state) => {
      for (const ws of state.getWebSockets()) ws.serializeAttachment({ ...((ws.deserializeAttachment() as F) ?? {}), ver: "прежняя" });
    });
    await evictDurableObject(fleet());
    const panel = await hello("client", "panel-desk");
    expect(await bare.waitClose()).toEqual({ code: 1012, reason: "relay_updated" });
    expect(panel.closed).toBeNull();
  });

  it("3138 · кадр прежнего соединения будит объект — все прежние закрыты 1012 relay_updated, строки abort нет; следующий вход живёт", async () => {
    // источник: чьё: код («кадры, бывшие в пути при смене кода, теряются молча»; abort — только ошибка в коде relay)
    const a = await laptop();
    const phone = await hello("client", "phone");
    await runInDurableObject(fleet(), async (_o, state) => {
      for (const ws of state.getWebSockets()) ws.serializeAttachment({ ...(ws.deserializeAttachment() as F), ver: "прежняя" });
    });
    await evictDurableObject(fleet());
    phone.send({ type: "session.history", v: 1, id: "h-1", callsign: "site@laptop" });
    for (const p of [a, phone]) expect(await p.waitClose()).toEqual({ code: 1012, reason: "relay_updated" });
    await wait(100);
    expect(logs.filter((l) => l.startsWith("abort"))).toEqual([]);
    const panel = await hello("client", "panel-desk");
    await wait(100);
    expect(panel.closed).toBeNull();
    expect(logs.filter((l) => l.startsWith("relay_updated"))).toHaveLength(1);
  });

  it("3139 · закрытые прежним кодом уходят из roster; вернувшаяся машина — с новым since и своими сессиями", async () => {
    // источник: чьё: код (уход соединения — roster всем); устав «соединение оборвалось → клиенты переподключаются»
    const a = await laptop();
    const since1 = (await a.roster()).machines.find((m: F) => m.machine === "laptop").since;
    await runInDurableObject(fleet(), async (_o, state) => {
      for (const ws of state.getWebSockets()) ws.serializeAttachment({ ...(ws.deserializeAttachment() as F), ver: "прежняя" });
    });
    await evictDurableObject(fleet());
    const panel = await hello("client", "panel-desk");
    await a.waitClose();
    await panel.until(() => (panel.frames.some((f) => f.type === "roster" && !f.machines.length) ? true : undefined), 3000, "roster без laptop");
    await wait(5);
    await laptop();
    const r = await panel.next((f) => f.type === "roster" && f.machines.some((m: F) => m.machine === "laptop"));
    expect(r.machines.find((m: F) => m.machine === "laptop").since).toBeGreaterThan(since1);
    expect(callsigns(r)).toEqual(["profiles@laptop", "site@laptop", "wiki@laptop"]);
  });

  it("3140 · ключ отозван, соединение прежнего кода — сначала relay_updated, на новый hello тем же ключом — revoked", async () => {
    // источник: чьё: код (карточка прежнего кода закрыта раньше проверки отозванных; отказ — в hello)
    const phone = await hello("client", "phone", {}, "k8e1");
    await env.GATE.revokeLater(["client.phone.k8e1"]);
    await runInDurableObject(fleet(), async (_o, state) => {
      for (const ws of state.getWebSockets()) ws.serializeAttachment({ ...(ws.deserializeAttachment() as F), ver: "прежняя" });
    });
    await evictDurableObject(fleet());
    const panel = await hello("client", "panel-desk");
    expect(await phone.waitClose()).toEqual({ code: 1012, reason: "relay_updated" });
    const again = await open();
    again.send({ type: "hello", proto: 1, key: await key("client", "phone", "k8e1") });
    expect(await again.waitClose()).toMatchObject({ code: 1008, reason: "revoked" });
    expect(panel.closed).toBeNull();
  });

  it("6 · session.open с machine и незнакомый relay budget.set с callsign — только Host laptop, поле в поле плюс from; машины нет — offline", async () => {
    const a = await laptop();
    const b = await pc();
    const panel = await hello("client", "panel-desk");
    const open = { type: "session.open", id: "c-1", machine: "laptop", dir: "~/x", model: "opus" };
    const budget = { type: "budget.set", id: "b-1", v: 1, callsign: "site@laptop", limit_usd: 20 };
    panel.send(open);
    panel.send(budget);
    expect(await a.next((f) => f.type === "session.open")).toEqual({ ...open, from: dev("panel-desk") });
    expect(await a.next((f) => f.type === "budget.set")).toEqual({ ...budget, from: dev("panel-desk") });
    expect(await b.quiet()).toEqual([]);
    panel.send({ type: "session.open", id: "c-7", machine: "nas" });
    expect(await panel.next((f) => f.type === "reply")).toMatchObject({ id: "c-7", ok: false, error: "offline" });
  });

  it("7 · panel-desk закрылся кодом 1000: всем roster без него; кадр с to [panel-desk] без id — молча", async () => {
    const a = await laptop();
    const phone = await hello("client", "phone");
    const panel = await hello("client", "panel-desk");
    await a.roster();
    await phone.roster();
    panel.close(1000);
    for (const p of [a, phone]) {
      const r = await eventually(async () => {
        const x = await p.roster();
        return x.clients.includes(dev("panel-desk")) ? undefined : x;
      });
      expect(r.clients).toEqual([dev("phone")]);
    }
    a.send({ type: "question", to: [dev("panel-desk")], question: "q-1" });
    expect(await a.quiet()).toEqual([]);
    expect(await phone.quiet()).toEqual([]);
  });

  it("40 · session.history h-3; объект засыпает; reply от Host с to panel-desk получают соединения panel-desk и только они", async () => {
    const a = await laptop();
    const panel = await hello("client", "panel-desk");
    const panel2 = await hello("client", "panel-desk");
    const phone = await hello("client", "phone");
    panel.send({ type: "session.history", id: "h-3", callsign: "site@laptop" });
    expect(await a.next((f) => f.type === "session.history")).toMatchObject({ id: "h-3", from: dev("panel-desk") });
    await evictDurableObject(fleet());
    a.send({ type: "reply", id: "h-3", to: dev("panel-desk"), ok: true, result: { turns: [] } });
    const want = { type: "reply", id: "h-3", to: dev("panel-desk"), ok: true, result: { turns: [] }, from: "@laptop" };
    expect(await panel.next((f) => f.type === "reply")).toEqual(want);
    expect(await panel2.next((f) => f.type === "reply")).toEqual(want);
    expect(await phone.quiet()).toEqual([]);
  });

  it("41 · новый hello той же машины закрывает прежнее соединение: 1000 replaced; сессии по разу, since новый, кадры — в новое", async () => {
    const old = await laptop();
    const panel = await hello("client", "panel-desk");
    const r1 = await panel.roster();
    await wait(5);
    const fresh = await laptop();
    expect(await old.waitClose()).toEqual({ code: 1000, reason: "replaced" });
    const r2 = await eventually(async () => {
      const x = await panel.roster();
      return x.machines[0].since !== r1.machines[0].since ? x : undefined;
    });
    expect(r2.machines.length).toBe(1);
    expect(callsigns(r2)).toEqual(["profiles@laptop", "site@laptop", "wiki@laptop"]);
    panel.send({ type: "message", to: "site@laptop", text: "hi" });
    expect(await fresh.next((f) => f.type === "message")).toMatchObject({ from: dev("panel-desk") });
  });

  it("44 · обработчик кадра бросает исключение: журнал с причиной и типом, ctx.abort, все соединения закрыты; после hello roster тот же", async () => {
    const a = await laptop();
    const panel = await hello("client", "panel-desk");
    const before = await panel.roster();
    await runInDurableObject(fleet(), (o) => {
      (o as unknown as { route: () => never }).route = () => {
        throw new TypeError("сбой в коде relay");
      };
    });
    a.send({ type: "message", to: dev("panel-desk") });
    await a.waitClose();
    await panel.waitClose();
    expect(logs.find((l) => l.startsWith("abort"))).toMatch(/сбой в коде relay[\s\S]*webSocketMessage\(message\)/);
    await laptop();
    const panel2 = await hello("client", "panel-desk");
    const after = await panel2.roster();
    expect({ ...after, machines: after.machines.map((m: F) => ({ ...m, since: 0 })) }).toEqual({ ...before, machines: before.machines.map((m: F) => ({ ...m, since: 0 })) });
  });

  it("45 · question с to [phone, panel-desk] и callsign — получили оба клиента, Host назад не получил, поля не тронуты", async () => {
    const a = await laptop();
    const phone = await hello("client", "phone");
    const panel = await hello("client", "panel-desk");
    const q = { type: "question", from: "profiles@laptop", to: [dev("phone"), dev("panel-desk")], callsign: "profiles@laptop", question: "q-4", options: ["да", "нет"] };
    a.send(q);
    expect(await phone.next((f) => f.type === "question")).toEqual(q);
    expect(await panel.next((f) => f.type === "question")).toEqual(q);
    expect(await a.quiet()).toEqual([]);
    // один адресат ушёл — второй получил, отказа нет
    phone.close();
    await eventually(async () => (!(await a.roster()).clients.includes(dev("phone")) ? true : undefined));
    a.send(q);
    expect(await panel.next((f) => f.type === "question")).toEqual(q);
    expect(await a.quiet()).toEqual([]);
  });

  it("46 · hello Host laptop с карточкой больше 16 384 байт — закрыт 1008 bad_frame; в журнале размер и предел; прежний Host и roster не тронуты", async () => {
    const a = await laptop();
    const before = await a.roster();
    const big = await open();
    const s = sessions("laptop", Array.from({ length: 60 }, (_, i) => `s${i}`), { note: "x".repeat(260) });
    big.send({ type: "hello", proto: 1, key: await key("host", "laptop", "k9z9"), sessions: s });
    expect(await big.waitClose()).toEqual({ code: 1008, reason: "bad_frame" });
    expect(logs.find((l) => l.startsWith("bad_frame host.laptop.k9z9"))).toMatch(/карточка \d+ байт · предел 16384/);
    expect(await a.quiet()).toEqual([]);
    expect(a.frames.filter((f) => f.type === "roster")).toEqual([]);
    expect(before.machines.length).toBe(1);
  });

  it("47 · первый кадр не hello — закрыт 1008 bad_frame, кадр не доставлен, gate.verify не вызван", async () => {
    const a = await laptop();
    await env.GATE.clear();
    const x = await open();
    x.send({ type: "message", to: "site@laptop", text: "hi" });
    expect(await x.waitClose()).toEqual({ code: 1008, reason: "bad_frame" });
    expect(await env.GATE.calls()).toEqual([]);
    expect(await a.quiet()).toEqual([]);
    expect(logs).toContain("bad_frame до hello · message");
  });

  it("118 · 132 · 143 · gate не ответил (сбой или нет FLEET_SECRET): телефон и Host pc закрыты 1008 gate_unavailable, причина в журнале без подписи; laptop на связи, roster не изменился", async () => {
    const a = await laptop();
    const b = await pc();
    await a.roster();
    await env.GATE.setMode("throw");
    const phone = await open();
    phone.send({ type: "hello", proto: 1, key: await key("client", "phone", "k8e1") });
    expect(await phone.waitClose()).toEqual({ code: 1008, reason: "gate_unavailable" });
    expect(logs.find((l) => l.startsWith("gate client.phone.k8e1"))).toMatch(/gate_unavailable · .*gate сломан/);
    expect(logs.join("\n")).not.toContain((await key("client", "phone", "k8e1")).split(".")[3]);
    expect(await a.quiet()).toEqual([]);
    expect(a.frames.filter((f) => f.clients?.includes(dev("phone")))).toEqual([]);
    expect(a.closed ?? b.closed).toBeNull();
    // Host другой машины — так же; машины mac нет в roster
    const mac = await open();
    mac.send({ type: "hello", proto: 1, key: await key("host", "mac"), sessions: sessions("mac", ["api"]) });
    expect(await mac.waitClose()).toEqual({ code: 1008, reason: "gate_unavailable" });
    // у gate нет FLEET_SECRET — переход закончен: ключ подписью — bad_key
    await env.GATE.setMode("nosecret");
    const x = await open();
    x.send({ type: "hello", proto: 1, key: await key("client", "tablet", "k8e1") });
    expect(await x.waitClose()).toEqual({ code: 1008, reason: "bad_key" });
    await env.GATE.setMode("real");
    const panel = await hello("client", "panel-desk");
    expect((await panel.roster()).machines.map((m: F) => m.machine)).toEqual(["laptop"]);
    expect(a.closed ?? b.closed).toBeNull();
  });

  it("133 · отозванный client.phone.k2a9 — закрыт 1008 revoked, слово gate как есть; у relay нет секрета флота", async () => {
    const phone = await open();
    phone.send({ type: "hello", proto: 1, key: await key("client", "phone", "k2a9") });
    expect(await phone.waitClose()).toEqual({ code: 1008, reason: "revoked" });
    expect(logs).toContain("revoked client.phone.k2a9");
    expect((env as unknown as F).FLEET_SECRET).toBeUndefined();
    expect((env as unknown as F).REVOKED).toBeUndefined();
  });

});

describe("эталоны экосистемы · relay", () => {
  it("30 · ключ host.laptop.k7f3 другим секретом — закрыт bad_key; в журнале имя ключа; кадры не дошли; roster не изменился", async () => {
    const phone = await hello("client", "phone");
    const x = await open();
    x.send({ type: "hello", proto: 1, key: await key("host", "laptop", "k7f3", "чужой секрет"), sessions: sessions("laptop", ["site"]) });
    x.send({ type: "message", to: dev("phone"), text: "hi" });
    expect(await x.waitClose()).toEqual({ code: 1008, reason: "bad_key" });
    expect(logs).toContain("bad_key host.laptop.k7f3");
    expect(await phone.quiet()).toEqual([]);
  });

  it("31 · после перезапуска relay все входят заново; отозванный k2a9 — revoked, новый ключ k8e1 проходит", async () => {
    await laptop();
    const panel = await hello("client", "panel-desk");
    await abortAllDurableObjects(); // выпуск relay: объект перезапущен, соединения рвутся
    await panel.waitClose();
    const old = await open();
    old.send({ type: "hello", proto: 1, key: await key("client", "phone", "k2a9") });
    expect(await old.waitClose()).toEqual({ code: 1008, reason: "revoked" });
    await laptop();
    const panel2 = await hello("client", "panel-desk");
    await hello("client", "phone", {}, "k8e1");
    const r = await panel2.roster();
    expect(r.clients.sort()).toEqual([dev("panel-desk"), dev("phone")]);
    expect(r.machines.map((m: F) => m.machine)).toEqual(["laptop"]);
  });

  it("32 · телефон с from site@laptop — bad_from, до Host не дошёл; тот же кадр без from — Host pc получил from phone", async () => {
    const b = await pc();
    const phone = await hello("client", "phone");
    phone.send({ type: "message", id: "m-8", from: "site@laptop", to: "poe-bot@pc", text: "…" });
    expect(await phone.next((f) => f.type === "reply")).toEqual({ type: "reply", id: "m-8", ok: false, error: "bad_from" });
    expect(await b.quiet()).toEqual([]);
    expect(logHas("bad_from phone~owner@example.com · message · from=site@laptop")).toBe(true);
    phone.send({ type: "message", id: "m-9", to: "poe-bot@pc", text: "…" });
    expect(await b.next((f) => f.type === "message")).toMatchObject({ id: "m-9", from: dev("phone") });
  });

  it("33 · Host laptop с from poe-bot@pc — bad_from; hello ключом laptop с сессией wiki@pc — закрыт bad_from, wiki@pc нет в roster", async () => {
    const a = await laptop();
    const b = await pc();
    a.send({ type: "message", id: "m-1", from: "poe-bot@pc", to: "api@pc" });
    expect(await a.next((f) => f.type === "reply")).toMatchObject({ id: "m-1", error: "bad_from" });
    expect(await b.quiet()).toEqual([]);
    const x = await open();
    x.send({ type: "hello", proto: 1, key: await key("host", "laptop"), sessions: [{ callsign: "wiki@pc" }] });
    expect(await x.waitClose()).toEqual({ code: 1008, reason: "bad_from" });
    expect(a.closed).toBeNull();
    const panel = await hello("client", "panel-desk");
    const r = await panel.roster();
    expect(r.sessions.filter((s: F) => s.callsign === "wiki@pc")).toEqual([]);
  });

  it("34 · hello с proto 2 — закрыт contract_mismatch; в журнале обе версии", async () => {
    const x = await open();
    x.send({ type: "hello", proto: 2, key: await key("host", "laptop") });
    expect(await x.waitClose()).toEqual({ code: 1008, reason: "contract_mismatch" });
    expect(logs).toContain("contract_mismatch host.laptop.k7f3 · proto 2 · relay [1]");
  });

});

describe("relay · разбор кадра", () => {
  it("не wss — 426; ping → pong автоответом", async () => {
    expect((await SELF.fetch("https://switchboard.test/")).status).toBe(426);
    const a = await laptop();
    a.send("ping");
    await eventually(() => a.raw.includes("pong") || undefined);
  });

  it("не JSON или без type — bad_frame: с id — reply, без id — только журнал", async () => {
    const a = await laptop();
    a.send('{"id":"x-1","to":"phone"}');
    expect(await a.next((f) => f.type === "reply")).toEqual({ type: "reply", id: "x-1", ok: false, error: "bad_frame" });
    a.send("не json");
    expect(await a.quiet()).toEqual([]);
    expect(logHas("bad_frame host.laptop · не кадр")).toBe(true);
  });

  it("2046 · to списком у кадра с id; нет адреса; callsign без машины; имя relay чужим кадром — bad_frame", async () => {
    const a = await laptop();
    a.send({ type: "question", id: "q-1", to: [dev("phone"), dev("panel-desk")] });
    expect(await a.next((f) => f.id === "q-1")).toMatchObject({ error: "bad_frame" });
    a.send({ type: "message", id: "q-2" });
    expect(await a.next((f) => f.id === "q-2")).toMatchObject({ error: "bad_frame" });
    a.send({ type: "budget.set", id: "q-5", callsign: "wiki" });
    expect(await a.next((f) => f.id === "q-5")).toMatchObject({ error: "bad_frame" });
    expect(logHas("callsign wiki")).toBe(true);
    a.send({ type: "roster", id: "q-3", machines: [] });
    expect(await a.next((f) => f.id === "q-3")).toMatchObject({ error: "bad_frame" });
    a.send({ type: "hello", id: "q-4", key: "x" });
    expect(await a.next((f) => f.id === "q-4")).toMatchObject({ error: "bad_frame" });
  });

  it("session.state заменяет запись целиком и с state null убирает; чужой callsign и не от Host — bad_from", async () => {
    const a = await laptop();
    const phone = await hello("client", "phone");
    await phone.roster();
    a.send({ type: "session.state", callsign: "site@laptop", state: "busy", slot: "b" });
    let r = await phone.roster();
    expect(r.sessions.find((s: F) => s.callsign === "site@laptop")).toEqual({ callsign: "site@laptop", state: "busy", slot: "b" });
    expect(callsigns(r)).toEqual(["profiles@laptop", "site@laptop", "wiki@laptop"]);
    a.send({ type: "session.state", callsign: "wiki@laptop", state: null });
    r = await phone.roster();
    expect(callsigns(r)).toEqual(["profiles@laptop", "site@laptop"]);
    a.send({ type: "session.state", callsign: "new@laptop", state: "idle" });
    r = await phone.roster();
    expect(callsigns(r)).toEqual(["new@laptop", "profiles@laptop", "site@laptop"]);
    a.send({ type: "session.state", id: "s-1", callsign: "poe-bot@pc", state: "idle" });
    expect(await a.next((f) => f.id === "s-1")).toMatchObject({ error: "bad_from" });
    phone.send({ type: "session.state", id: "s-2", callsign: "x@phone", state: "idle" });
    expect(await phone.next((f) => f.id === "s-2")).toMatchObject({ error: "bad_from" });
  });

  it("Host без from — from @машина; to @машина доставляет Host этой машины", async () => {
    const a = await laptop();
    const b = await pc();
    a.send({ type: "machine.dirs", id: "d-1", to: "@pc" });
    expect(await b.next((f) => f.type === "machine.dirs")).toEqual({ type: "machine.dirs", id: "d-1", to: "@pc", from: "@laptop" });
  });

  it("2045 · session.state раздул карточку за предел — bad_frame, запись прежняя", async () => {
    const a = await laptop();
    const phone = await hello("client", "phone");
    await phone.roster();
    a.send({ type: "session.state", id: "s-big", callsign: "site@laptop", state: "busy", note: "x".repeat(17_000) });
    expect(await a.next((f) => f.id === "s-big")).toMatchObject({ ok: false, error: "bad_frame" });
    expect(logs.find((l) => l.startsWith("bad_frame @laptop · session.state"))).toMatch(/карточка \d+ байт · предел 16384/);
    expect(await phone.quiet()).toEqual([]);
    a.send({ type: "session.state", callsign: "wiki@laptop", state: "busy" });
    const r = await phone.roster();
    expect(r.sessions.find((s: F) => s.callsign === "site@laptop").state).toBe("idle");
  });

  it("2047 · спросивший ушёл — ответ Host не доставлен, Host получает offline с тем же id", async () => {
    const a = await laptop();
    const panel = await hello("client", "panel-desk");
    panel.send({ type: "session.history", id: "h-9", callsign: "site@laptop" });
    await a.next((f) => f.type === "session.history");
    panel.close();
    await eventually(async () => ((await a.roster()).clients.length === 0 ? true : undefined));
    a.send({ type: "reply", id: "h-9", to: dev("panel-desk"), ok: true, result: {} });
    expect(await a.next((f) => f.type === "reply")).toEqual({ type: "reply", id: "h-9", ok: false, error: "offline" });
  });

  it("2048 · сокет закрылся до hello — roster не рассылается", async () => {
    const a = await laptop();
    await a.roster();
    const x = await open();
    x.close();
    expect(await a.quiet(200)).toEqual([]);
    expect(a.frames.filter((f) => f.type === "roster")).toEqual([]);
  });

  it("клиент с двумя соединениями получает кадр в оба; roster перечисляет его один раз", async () => {
    const a = await laptop();
    const p1 = await hello("client", "phone");
    const p2 = await hello("client", "phone");
    expect((await p2.roster()).clients).toEqual([dev("phone")]);
    a.send({ type: "question", to: dev("phone"), q: 1 });
    await p1.next((f) => f.type === "question");
    await p2.next((f) => f.type === "question");
  });
});

describe("адреса и keeper машины", () => {
  it("keeper входит своим ключом: в roster его нет, roster он получает; кадр на .keeper@laptop — только ему, from Host — @laptop", async () => {
    const a = await laptop();
    const k = await hello("keeper", "laptop");
    const r = await a.roster();
    expect(r.machines.map((m: F) => m.machine)).toEqual(["laptop"]);
    expect(r.clients).toEqual([]);
    const phone = await hello("client", "phone");
    phone.send({ type: "keeper.state", id: "k-1", to: ".keeper@laptop" });
    expect(await k.next((f) => f.type === "keeper.state")).toEqual({ type: "keeper.state", id: "k-1", to: ".keeper@laptop", from: dev("phone") });
    expect(a.frames.find((f) => f.type === "keeper.state")).toBeUndefined();
    k.send({ type: "reply", id: "k-1", to: dev("phone"), ok: true, result: { keeper: "1.1.60" } });
    expect(await phone.next((f) => f.type === "reply")).toEqual({ type: "reply", id: "k-1", to: dev("phone"), ok: true, result: { keeper: "1.1.60" }, from: ".keeper@laptop" });
  });

  it("keeper машины нет на связи — offline; второй keeper той же машины вытесняет первого словом replaced", async () => {
    const a = await laptop();
    a.send({ type: "keeper.state", id: "k-2", to: ".keeper@laptop" });
    expect(await a.next((f) => f.type === "reply")).toEqual({ type: "reply", id: "k-2", ok: false, error: "offline" });
    const k1 = await hello("keeper", "laptop");
    const k2 = await hello("keeper", "laptop");
    await k1.until(() => k1.closed, 3000, "закрыт");
    expect(k1.closed).toEqual({ code: 1000, reason: "replaced" });
    a.send({ type: "keeper.state", id: "k-3", to: ".keeper@laptop" });
    expect(await k2.next((f) => f.type === "keeper.state")).toMatchObject({ id: "k-3", from: "@laptop" });
  });

  it("Host не пишет от имени keeper или чужой машины; keeper — только от себя", async () => {
    const a = await laptop();
    const k = await hello("keeper", "laptop");
    const phone = await hello("client", "phone");
    a.send({ type: "message", id: "m-1", from: ".keeper@laptop", to: dev("phone") });
    expect(await a.next((f) => f.type === "reply")).toEqual({ type: "reply", id: "m-1", ok: false, error: "bad_from" });
    k.send({ type: "message", id: "m-2", from: "@laptop", to: dev("phone") });
    expect(await k.next((f) => f.type === "reply")).toEqual({ type: "reply", id: "m-2", ok: false, error: "bad_from" });
    // служба — не через relay: Worker'ы зовут напрямую POST
    k.send({ type: "ledger.add", id: "l-1", to: ".ledger", ev: "part.updated", text: "x" });
    expect(await k.next((f) => f.type === "reply")).toEqual({ type: "reply", id: "l-1", ok: false, error: "offline" });
    expect(phone.frames.find((f) => f.type === "message")).toBeUndefined();
  });

  it("keeper: roster — только ему и один, при входе; его вход и уход флоту roster не рассылают, смены сессий keeper не получает", async () => {
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

  it("часть машины в адресе — только keeper: .host@laptop — offline; hello ключом машины с part не keeper — bad_frame", async () => {
    const a = await laptop();
    const phone = await hello("client", "phone");
    phone.send({ type: "keeper.state", id: "h-1", to: ".host@laptop" });
    expect(await phone.next((f) => f.type === "reply")).toMatchObject({ id: "h-1", ok: false, error: "offline" });
    const p = await open();
    p.send({ type: "hello", key: await key("host", "laptop"), proto: 1, part: "capture" });
    expect(await p.waitClose()).toEqual({ code: 1008, reason: "bad_frame" });
    expect(a.closed).toBeFalsy();
  });

  it("~email — все устройства пользователя; голое имя — не адрес: bad_frame", async () => {
    const a = await laptop();
    const p1 = await hello("client", "phone");
    const p2 = await hello("client", "panel-desk");
    a.send({ type: "message", to: "~" + OWNER, text: "всем" });
    await p1.next((f) => f.type === "message");
    await p2.next((f) => f.type === "message");
    a.send({ type: "message", id: "m-3", to: "phone", text: "голое" });
    expect(await a.next((f) => f.type === "reply")).toEqual({ type: "reply", id: "m-3", ok: false, error: "bad_frame" });
  });

  it("2087 · ~email без его устройств на связи — offline; устройства другого человека кадр не получают", async () => {
    // источник: чьё: код (доставка по reaches; адресата нет — offline)
    const a = await laptop();
    const p1 = await hello("client", "phone");
    a.send({ type: "message", id: "m-2087", to: "~stranger@example.com", text: "чужому" });
    expect(await a.next((f) => f.type === "reply")).toEqual({ type: "reply", id: "m-2087", ok: false, error: "offline" });
    a.send({ type: "message", to: "~" + OWNER, text: "своему" });
    expect(await p1.next((f) => f.type === "message")).toMatchObject({ text: "своему" });
  });
});
