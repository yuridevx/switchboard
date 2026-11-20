// Эталоны платформы, вторая волна: предел входа, картина для модели, пропуска и люди, вход внешнего клиента по OAuth.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Frame, MachineRow, PassRow, PersonRow, SessionRow } from "@sb/protocol";
import { fleetStub, HELLO_MS, machineStub, s256 } from "../src/env.ts";
import { clientDoc, platformApi } from "../src/index.ts";
import { ANYA, api, ask, boot, E, hangUp, host, newFleet, OLEG, page, pass, row, socket, tick, trio, YURI } from "./kit.ts";

afterEach(hangUp);

const names = (ms: MachineRow[]) => ms.map((m) => m.name).sort();

/** Соединение без `hello`: ответ — когда объект его принял и завёл предел; closed — его закрытие. */
async function silent(path: string): Promise<{ closed: Promise<{ code: number; reason: string }> }> {
  const ws = await socket(path);
  return { closed: new Promise((resolve) => ws.addEventListener("close", (e) => resolve({ code: e.code, reason: e.reason }))) };
}

describe("предел входа", () => {
  // время предела — поддельное: тест сдвигает часы объекта на HELLO_MS
  afterEach(() => {
    vi.useRealTimers();
  });

  it("соединение, которое не представилось, закрывается словом hello_timeout — у объекта флота и у объекта машины", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const fleet = newFleet();
    await boot(fleet);
    const f = await silent("/f/" + fleet);
    await tick(fleetStub(E, fleet), HELLO_MS);
    expect((await f.closed).reason).toBe("hello_timeout");
    const m = await silent("/m/" + fleet + "/laptop");
    await tick(machineStub(E, fleet, "laptop"), HELLO_MS);
    expect((await m.closed).reason).toBe("hello_timeout");
  });

  it("вошедшее соединение предел не трогает", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const fleet = newFleet(), yuri = await boot(fleet);
    const p = await page(fleet, yuri);
    await p.next((f) => f.type === "roster");
    await tick(fleetStub(E, fleet), HELLO_MS);
    // барьер: закрытие пришло бы раньше ответа на ping
    expect(await p.sync()).toBe("pong");
  });
});

describe("картина флота одним ответом", () => {
  it("человек получает машины, сессии и людей на связи — только то, до чего достаёт", async () => {
    const t = await trio();
    const hl = await host(t.fleet, "laptop", t.laptop);
    hl.send({ type: "machine.hello", build: 1, sessions: [row("site@laptop")] });
    const ho = await host(t.fleet, "oleg-mac", t.omac);
    ho.send({ type: "machine.hello", build: 1, sessions: [row("pay@oleg-mac")] });
    const py = await page(t.fleet, t.yuri);
    await py.next((f) => f.type === "roster");
    const po = await page(t.fleet, t.oleg);
    await po.next((f) => f.type === "roster");
    // Host пишет в картину не мгновенно: дождаться строк
    await py.next((f) => f.type === "roster.delta" && JSON.stringify(f).includes("pay@oleg-mac")).catch(() => undefined);

    const anya = (await ask(t.fleet, t.anya, { type: "fleet.list" })).result as { machines: MachineRow[]; sessions: SessionRow[]; people: { person: string; devices: string[] }[] };
    expect(names(anya.machines)).toEqual(["anya-pc", "laptop", "server"]);
    expect(anya.sessions.map((s) => s.callsign)).toEqual(["site@laptop"]);
    // Юра на связи и делит с Аней проект; Олег — нет
    expect(anya.people).toEqual([{ person: YURI, devices: ["pult" + YURI] }]);

    const yuri = (await ask(t.fleet, t.yuri, { type: "fleet.list" })).result as typeof anya;
    expect(names(yuri.machines)).toEqual(["anya-pc", "laptop", "oleg-mac", "server"]);
    expect(yuri.people.map((p) => p.person)).toEqual([OLEG, YURI]);

    expect((await ask(t.fleet, t.yuri, { type: "fleet.list", machine: "oleg-mac" })).result).toMatchObject({ sessions: [{ callsign: "pay@oleg-mac" }] });
    expect(await ask(t.fleet, t.anya, { type: "fleet.list", machine: "oleg-mac" })).toMatchObject({ ok: false, error: "forbidden" });
  });

  it("сессия спрашивает пропуском своей машины и видит то, до чего достаёт владелец машины", async () => {
    const t = await trio();
    const who = await api.who(t.apc, "forms@anya-pc");
    if ("error" in who) throw new Error(who.error);
    const r = await api.fleetCall(t.fleet, who, { type: "fleet.list", id: "s1" });
    expect(names((r.result as { machines: MachineRow[] }).machines)).toEqual(["anya-pc", "laptop", "server"]);
  });

  it("службам: строки сессий флота и админы", async () => {
    const fleet = newFleet(), yuri = await boot(fleet), laptop = await pass(fleet, yuri, "@laptop");
    await pass(fleet, yuri, "pult" + ANYA);
    const h = await host(fleet, "laptop", laptop);
    const p = await page(fleet, yuri);
    h.send({ type: "machine.hello", build: 1, sessions: [row("a@laptop", { account: "deepseek" })] });
    await p.next((f) => f.type === "roster.delta" && !!f.sessions);
    expect((await api.sessions(fleet)).map((s) => [s.callsign, s.account])).toEqual([["a@laptop", "deepseek"]]);
    expect(await api.admins(fleet)).toEqual([YURI]);
  });
});

describe("пропуска и люди", () => {
  it("список пропусков: вид, номера, кто пригласил, на связи ли", async () => {
    const t = await trio();
    const all = ((await ask(t.fleet, t.yuri, { type: "passes" })).result as { passes: PassRow[] }).passes;
    expect(all).toHaveLength(7);
    const machines = ((await ask(t.fleet, t.yuri, { type: "passes", kind: "machine" })).result as { passes: PassRow[] }).passes;
    expect(machines.map((p) => p.addr).sort()).toEqual(["@anya-pc", "@laptop", "@oleg-mac", "@server"]);
    // машину Ани пригласила Аня, её устройство — Юра
    expect(machines.find((p) => p.addr === "@anya-pc")).toMatchObject({ by: "pult" + ANYA, online: false });
    expect(all.find((p) => p.addr === "pult" + ANYA)).toMatchObject({ by: "pult" + YURI });
    const kid = machines.find((p) => p.addr === "@laptop")!.kid;
    expect(((await ask(t.fleet, t.yuri, { type: "passes", kids: [kid, "nope"] })).result as { passes: PassRow[] }).passes.map((p) => p.addr)).toEqual(["@laptop"]);
    // на связи: машина — когда её Host подключён; устройство — когда открыта страница
    const h = await host(t.fleet, "laptop", t.laptop);
    const p = await page(t.fleet, t.yuri);
    await p.next((f) => f.type === "roster");
    h.send({ type: "machine.hello", build: 1, sessions: [] });
    await p.next((f) => f.type === "roster.delta" && !!(f.machines as MachineRow[] | undefined)?.some((m) => m.name === "laptop" && m.online));
    const now = ((await ask(t.fleet, t.yuri, { type: "passes" })).result as { passes: PassRow[] }).passes;
    expect(now.find((x) => x.addr === "@laptop")!.online).toBe(true);
    expect(now.find((x) => x.addr === "pult" + YURI)!.online).toBe(true);
    expect(now.find((x) => x.addr === "pult" + ANYA)!.online).toBe(false);
  });

  it("люди: устройства человека с метками «на связи» и «ждёт входа»", async () => {
    const fleet = newFleet(), yuri = await boot(fleet);
    await ask(fleet, yuri, { type: "invite", addr: "phone" + ANYA });
    const p = await page(fleet, yuri);
    await p.next((f) => f.type === "roster");
    const people = ((await ask(fleet, yuri, { type: "people.list" })).result as { people: PersonRow[] }).people;
    expect(people.find((x) => x.person === YURI)).toMatchObject({ online: true, devices: [{ addr: "pult" + YURI, wait: false, online: true }] });
    expect(people.find((x) => x.person === ANYA)).toMatchObject({ online: false, devices: [{ addr: "phone" + ANYA, wait: true, online: false }] });
  });

  it("приглашение нового человека: уже во флоте — отказ exists; без пометки — второе устройство выдаётся", async () => {
    const fleet = newFleet(), yuri = await boot(fleet);
    expect((await ask(fleet, yuri, { type: "invite", addr: "pult" + ANYA, fresh: true })).ok).toBe(true);
    expect(await ask(fleet, yuri, { type: "invite", addr: "phone" + ANYA, fresh: true })).toMatchObject({ ok: false, error: "exists" });
    expect((await ask(fleet, yuri, { type: "invite", addr: "phone" + ANYA })).ok).toBe(true);
  });
});

describe("вход внешнего клиента по OAuth", () => {
  const CLIENT = "https://claude.example/oauth/client.json", BACK = "https://claude.example/callback";
  const docs = (doc: unknown, status = 200) => (async () => new Response(JSON.stringify(doc), { status })) as unknown as typeof fetch;
  const good = docs({ client_id: CLIENT, client_name: "Claude", client_uri: "https://claude.example", redirect_uris: [BACK, "http://127.0.0.1:1/cb"] });

  async function consent(fleet: string, key: string, net: typeof fetch, extra: Frame | object = {}) {
    const who = await api.who(key);
    if ("error" in who) throw new Error(who.error);
    return platformApi(E, net).fleetCall(fleet, who, { type: "consent", id: "c1", client: CLIENT, back: BACK, challenge: await s256("verifier-verifier-verifier"), ...extra });
  }
  const token = (code: string, o: { verifier?: string; client?: string; back?: string } = {}) =>
    api.fleetCall("", null, { type: "redeem", id: "t1", invite: code, verifier: o.verifier ?? "verifier-verifier-verifier", client: o.client ?? CLIENT, back: o.back ?? BACK });

  it("согласие даёт код; код с проверочным словом становится пропуском устройства человека", async () => {
    const fleet = newFleet(), yuri = await boot(fleet), laptop = await pass(fleet, yuri, "@laptop");
    const c = await consent(fleet, yuri, good, { label: "claude" });
    expect(c).toMatchObject({ ok: true, result: { client: { name: "Claude", uri: "https://claude.example" } } });
    const { code, addr } = c.result as { code: string; addr: string };
    expect(addr).toMatch(/^claude-[a-z0-9]{4}~yuri@example\.com$/);
    const t = await token(code);
    expect(t).toMatchObject({ ok: true, result: { addr } });
    const who = await api.who((t.result as { key: string }).key);
    expect(who).toMatchObject({ addr, person: YURI, admin: true, machines: ["laptop"] });
    // код одноразовый
    expect(await token(code)).toMatchObject({ ok: false, error: "bad_invite" });
    void laptop;
  });

  it("код не принимается без проверочного слова, с чужим словом, клиентом или адресом возврата", async () => {
    const fleet = newFleet(), yuri = await boot(fleet);
    const { code } = (await consent(fleet, yuri, good)).result as { code: string };
    expect(await api.fleetCall("", null, { type: "redeem", id: "r", invite: code })).toMatchObject({ ok: false, error: "bad_invite" });
    expect(await token(code, { verifier: "other-other-other-other" })).toMatchObject({ ok: false, error: "bad_invite" });
    expect(await token(code, { client: "https://evil.example/c.json" })).toMatchObject({ ok: false, error: "bad_invite" });
    expect(await token(code, { back: "https://evil.example/cb" })).toMatchObject({ ok: false, error: "bad_invite" });
    // после отказов тот же код с верными данными принимается
    expect((await token(code)).ok).toBe(true);
  });

  it("обычное приглашение — не код входа", async () => {
    const fleet = newFleet(), yuri = await boot(fleet);
    const inv = ((await ask(fleet, yuri, { type: "invite", addr: "phone" + YURI })).result as { invite: string }).invite;
    expect(await token(inv)).toMatchObject({ ok: false, error: "bad_invite" });
  });

  it("описание клиента: адреса возврата нет, client_id не тот, описание не отдано — отказ bad_client", async () => {
    const fleet = newFleet(), yuri = await boot(fleet);
    expect(await consent(fleet, yuri, good, { back: "https://evil.example/cb" })).toMatchObject({ ok: false, error: "bad_client" });
    expect(await consent(fleet, yuri, docs({ client_id: "https://other.example/c.json", redirect_uris: [BACK] }))).toMatchObject({ ok: false, error: "bad_client" });
    expect(await consent(fleet, yuri, docs({}, 404))).toMatchObject({ ok: false, error: "bad_client" });
    expect(await consent(fleet, yuri, good, { client: "http://claude.example/c.json" })).toMatchObject({ ok: false, error: "bad_client" });
  });

  it("локальный адрес возврата принимается с любым портом", async () => {
    expect(await clientDoc(good, CLIENT, "http://127.0.0.1:53211/cb")).toEqual({ name: "Claude", uri: "https://claude.example" });
    expect(await clientDoc(good, CLIENT, "http://127.0.0.1:53211/other")).toHaveProperty("why");
  });

  it("согласие даёт только человек со своего устройства", async () => {
    const fleet = newFleet(), yuri = await boot(fleet), laptop = await pass(fleet, yuri, "@laptop");
    expect(await consent(fleet, laptop, good)).toMatchObject({ ok: false, error: "forbidden" });
  });
});

describe("картина для модели: фильтры", () => {
  it("fleet.list отбирает сессии по проекту и по состоянию", async () => {
    const t = await trio();
    const hl = await host(t.fleet, "laptop", t.laptop);
    hl.send({ type: "machine.hello", build: 1, sessions: [{ ...row("site@laptop"), state: "busy", spec: { name: "site", cwd: "~/p", project: "site" } }, { ...row("docs@laptop"), state: "idle" }] });
    const py = await page(t.fleet, t.yuri);
    await py.next((f) => (f.type === "roster" || f.type === "roster.delta") && JSON.stringify(f).includes("docs@laptop"));
    const list = async (f: Record<string, unknown>) => ((await ask(t.fleet, t.yuri, { type: "fleet.list", ...f })).result as { sessions: SessionRow[] }).sessions.map((s) => s.callsign);
    expect((await list({})).sort()).toEqual(["docs@laptop", "site@laptop"]);
    expect(await list({ state: "busy" })).toEqual(["site@laptop"]);
    expect(await list({ project: "site" })).toEqual(["site@laptop"]);
    expect(await list({ project: "site", state: "idle" })).toEqual([]);
  });
});

// чьё: факт прода 15 нояб. — 46 311 знаков на 57 сессий, 68% знаков всех ответов инструментов
describe("картина для модели: короткая строка", () => {
  it("fleet.list без параметров — короткая строка сессии; с full: true — полная", async () => {
    const t = await trio();
    const hl = await host(t.fleet, "laptop", t.laptop);
    const ask1 = { id: "q7", kind: "question", text: "Какую ветку брать?", at: 5, options: [{ label: "main" }], input: { questions: [] }, seen: ["pult~yuri@example.com"] };
    const full = { ...row("site@laptop"), state: "waiting", title: "Шапка сайта", doing: "Команда npm test", result: "Дописал раздел «Выкладка»: три шага", unread: ["~yuri@example.com"], account: "a@b.c", cache: { until: 9, size: 120_000 }, ask: ask1,
      spec: { name: "site", cwd: "~/p", key: "claude", model: "claude-opus-5-5", effort: "high", mode: "all", parent: "lead@laptop", project: "q7k2", pieces: ["base"], title: "Шапка сайта" } };
    hl.send({ type: "machine.hello", build: 1, sessions: [full] });
    const py = await page(t.fleet, t.yuri);
    await py.next((f) => (f.type === "roster" || f.type === "roster.delta") && JSON.stringify(f).includes("site@laptop"));
    const list = async (f: Record<string, unknown>) => ((await ask(t.fleet, t.yuri, { type: "fleet.list", ...f })).result as { sessions: unknown[] }).sessions;
    expect(await list({})).toEqual([{ callsign: "site@laptop", state: "waiting", title: "Шапка сайта", cwd: "~/p", key: "claude", model: "claude-opus-5-5", parent: "lead@laptop", project: "q7k2", doing: "Команда npm test", ask: { id: "q7", kind: "question", text: "Какую ветку брать?" } }]);
    expect(await list({ full: true })).toMatchObject([{ callsign: "site@laptop", spec: { effort: "high", pieces: ["base"] }, result: "Дописал раздел «Выкладка»: три шага", unread: ["~yuri@example.com"] }]);
    // отбор по проекту работает и с короткой строкой
    expect(await list({ project: "q7k2" })).toHaveLength(1);
    expect(await list({ project: "нет" })).toEqual([]);
  });
});

