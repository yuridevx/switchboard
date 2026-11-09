// Эталоны платформы: одно свойство на зафиксированном входе. Источник — дизайн «Switchboard с нуля», если не названо иное.
import { evictDurableObject, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Frame, MachineRow, SessionRow } from "@sb/protocol";
import { fleetStub, machineStub } from "../src/env.ts";
import { ANYA, api, ask, boot, connect, E, host, newFleet, OLEG, page, pass, redeem, row, trio, watcher, YURI } from "./kit.ts";

const names = (f: Frame) => ((f.machines as MachineRow[] | undefined) ?? []).map((m) => m.name).sort();
const calls = (f: Frame) => ((f.sessions as Array<{ callsign: string }> | undefined) ?? []).map((s) => s.callsign).sort();

describe("картина флота", () => {
  it("снимок Host заменяет строки его машины", async () => {
    const fleet = newFleet(), yuri = await boot(fleet), laptop = await pass(fleet, yuri, "@laptop");
    const p = await page(fleet, yuri);
    expect(names(await p.next((f) => f.type === "roster"))).toEqual(["laptop"]);
    const h1 = await host(fleet, "laptop", laptop);
    h1.send({ type: "machine.hello", build: 412, sdk: "0.3.321", os: "windows", sessions: [row("a@laptop"), row("b@laptop")] });
    const d1 = await p.next((f) => f.type === "roster.delta" && !!f.sessions);
    expect(calls(d1)).toEqual(["a@laptop", "b@laptop"]);
    expect((d1.machines as MachineRow[])[0]).toMatchObject({ name: "laptop", online: true, build: 412, os: "windows" });
    // Host переподключился с другим набором: прежнее соединение вытеснено, строки заменены
    const h2 = await host(fleet, "laptop", laptop);
    h2.send({ type: "machine.hello", build: 413, sessions: [row("b@laptop"), row("c@laptop")] });
    const d2 = await p.next((f) => f.type === "roster.delta" && !!f.sessions);
    expect(d2.sessions).toContainEqual({ callsign: "a@laptop", row: null });
    expect(calls(d2)).toEqual(["a@laptop", "b@laptop", "c@laptop"]);
    expect((await h1.closed).reason).toBe("replaced");
    const fresh = await page(fleet, yuri);
    const r = await fresh.next((f) => f.type === "roster");
    expect(calls(r)).toEqual(["b@laptop", "c@laptop"]);
    expect((r.machines as MachineRow[])[0]).toMatchObject({ online: true, build: 413 });
  });

  it("изменение строки доходит странице как roster.delta и заменяет строку целиком", async () => {
    const fleet = newFleet(), yuri = await boot(fleet), laptop = await pass(fleet, yuri, "@laptop");
    const h = await host(fleet, "laptop", laptop);
    h.send({ type: "machine.hello", build: 1, sessions: [row("site@laptop")] });
    const p = await page(fleet, yuri);
    await p.next((f) => f.type === "roster" || (f.type === "roster.delta" && !!f.sessions));
    const ask1 = { id: "q-9", kind: "question", text: "Какую ветку?", at: 5 };
    h.send({ type: "session.state", callsign: "site@laptop", row: { ...row("site@laptop"), state: "waiting", ask: ask1 } });
    const d = await p.next((f) => f.type === "roster.delta" && calls(f).includes("site@laptop") && (f.sessions as any)[0].row?.state === "waiting");
    expect(d.sessions).toEqual([{ callsign: "site@laptop", row: { ...row("site@laptop"), state: "waiting", ask: ask1 } }]);
    h.send({ type: "session.state", callsign: "site@laptop", row: { ...row("site@laptop"), state: "busy", ask: null } });
    await p.next((f) => f.type === "roster.delta" && (f.sessions as any)?.[0]?.row?.state === "busy");
    const r = await (await page(fleet, yuri)).next((f) => f.type === "roster");
    // строка идёт целиком: в картине — последняя присланная
    expect((r.sessions as SessionRow[])[0]).toMatchObject({ callsign: "site@laptop", state: "busy", ask: null, spec: { name: "site", cwd: "~/p" } });
    // сессии больше нет
    h.send({ type: "session.state", callsign: "site@laptop", row: null });
    expect((await p.next((f) => f.type === "roster.delta" && (f.sessions as any)?.[0]?.row === null)).sessions).toEqual([{ callsign: "site@laptop", row: null }]);
  });

  it("машина ушла со связи — её сессии видны, машина с пометкой «нет связи»", async () => {
    const fleet = newFleet(), yuri = await boot(fleet), laptop = await pass(fleet, yuri, "@laptop");
    const h = await host(fleet, "laptop", laptop);
    h.send({ type: "machine.hello", build: 1, sessions: [row("site@laptop")] });
    const p = await page(fleet, yuri);
    await p.next((f) => (f.type === "roster" && calls(f).length === 1) || (f.type === "roster.delta" && !!f.sessions));
    h.ws.close(1000, "bye");
    const d = await p.next((f) => f.type === "roster.delta" && (f.machines as MachineRow[] | undefined)?.[0]?.online === false);
    expect(d.sessions).toBeUndefined();
    const r = await (await page(fleet, yuri)).next((f) => f.type === "roster");
    expect((r.machines as MachineRow[])[0]).toMatchObject({ name: "laptop", online: false });
    expect(calls(r)).toEqual(["site@laptop"]);
  });

  it("300 сессий в снимке доходят странице целиком", async () => {
    // факт: в прежней системе картина жила в карточке соединения с пределом 16 КБ
    const fleet = newFleet(), yuri = await boot(fleet), laptop = await pass(fleet, yuri, "@laptop");
    const sessions = Array.from({ length: 300 }, (_, i) => row("s" + i + "@laptop", { title: "Сессия с длинным заголовком номер " + i, doing: "читает файлы проекта и готовит правку" }));
    const h = await host(fleet, "laptop", laptop);
    const p = await page(fleet, yuri);
    await p.next((f) => f.type === "roster");
    h.send({ type: "machine.hello", build: 1, sessions });
    expect(calls(await p.next((f) => f.type === "roster.delta" && !!f.sessions))).toHaveLength(300);
    expect(calls(await (await page(fleet, yuri)).next((f) => f.type === "roster"))).toHaveLength(300);
  });

  it("картина переживает усыпление объекта флота: страница получает изменения и после него", async () => {
    const fleet = newFleet(), yuri = await boot(fleet), laptop = await pass(fleet, yuri, "@laptop");
    const h = await host(fleet, "laptop", laptop);
    const p = await page(fleet, yuri);
    await p.next((f) => f.type === "roster");
    await evictDurableObject(fleetStub(E, fleet));
    h.send({ type: "machine.hello", build: 7, sessions: [row("site@laptop")] });
    expect(calls(await p.next((f) => f.type === "roster.delta" && !!f.sessions))).toEqual(["site@laptop"]);
  });
});

describe("кто пришёл и что может", () => {
  it("человек видит в картине только свои машины и машины тех, с кем общий проект", async () => {
    const t = await trio();
    const seen = async (key: string) => names(await (await page(t.fleet, key)).next((f) => f.type === "roster"));
    expect(await seen(t.anya)).toEqual(["anya-pc", "laptop", "server"]);
    expect(await seen(t.oleg)).toEqual(["laptop", "oleg-mac", "server"]);
    expect(await seen(t.yuri)).toEqual(["anya-pc", "laptop", "oleg-mac", "server"]);
    // и изменения чужой машины до человека не доходят
    const a = await page(t.fleet, t.anya);
    await a.next((f) => f.type === "roster");
    const ho = await host(t.fleet, "oleg-mac", t.omac), hl = await host(t.fleet, "laptop", t.laptop);
    ho.send({ type: "machine.hello", build: 1, sessions: [row("x@oleg-mac")] });
    hl.send({ type: "machine.hello", build: 1, sessions: [row("site@laptop")] });
    expect(calls(await a.next((f) => f.type === "roster.delta" && !!f.sessions))).toEqual(["site@laptop"]);
    expect(a.frames.some((f) => calls(f).includes("x@oleg-mac"))).toBe(false);
  });

  it("не админ достаёт до чужих машин только через общий проект", async () => {
    const fleet = newFleet(), yuri = await boot(fleet);
    const anya = await pass(fleet, yuri, "pult" + ANYA), oleg = await pass(fleet, yuri, "pult" + OLEG);
    await pass(fleet, anya, "@anya-pc");
    await pass(fleet, oleg, "@oleg-mac");
    const reach = async (key: string) => ((await api.who(key)) as { machines: string[] }).machines.sort();
    expect(await reach(anya)).toEqual(["anya-pc"]);
    expect((await ask(fleet, yuri, { type: "project.set", project: "duo", name: "Дуэт", members: [ANYA, OLEG] })).ok).toBe(true);
    expect(await reach(anya)).toEqual(["anya-pc", "oleg-mac"]);
    expect(await reach(oleg)).toEqual(["anya-pc", "oleg-mac"]);
    expect((await ask(fleet, yuri, { type: "project.remove", project: "duo" })).ok).toBe(true);
    expect(await reach(oleg)).toEqual(["oleg-mac"]);
  });

  it("подключение зрителя к чужой машине — forbidden; к своей — принято", async () => {
    const t = await trio();
    const no = await watcher(t.fleet, "oleg-mac", t.anya);
    expect((await no.closed).reason).toBe("forbidden");
    const h = await host(t.fleet, "laptop", t.laptop);
    const yes = await watcher(t.fleet, "laptop", t.anya);
    yes.send({ type: "session.watch", id: "w1", to: "site@laptop" });
    expect(await yes.next((f) => f.type === "reply")).toMatchObject({ id: "w1", ok: true, result: { got: "session.watch", from: "pult" + ANYA } });
    h.ws.close();
  });

  it("машина говорит за свою сессию, за чужую — отказ", async () => {
    const t = await trio();
    expect(await api.who(t.laptop)).toMatchObject({ addr: "@laptop", person: YURI });
    expect(await api.who(t.laptop, "site@laptop")).toMatchObject({ addr: "site@laptop", person: YURI });
    expect(await api.who(t.laptop, "docs@server")).toMatchObject({ error: "forbidden" });
    // устройство за сессию не говорит
    expect(await api.who(t.anya, "site@laptop")).toMatchObject({ error: "forbidden" });
    expect(await api.who("нет")).toMatchObject({ error: "bad_key" });
    expect(await api.who(t.fleet + ":abcdef1234:0123456789abcdef0123")).toMatchObject({ error: "bad_key" });
  });

  it("Host и Keeper входят только пропуском своей машины", async () => {
    const t = await trio();
    expect((await (await host(t.fleet, "laptop", t.server)).closed).reason).toBe("forbidden");
    expect((await (await host(t.fleet, "laptop", t.yuri)).closed).reason).toBe("forbidden");
    expect((await (await page(t.fleet, t.laptop)).closed).reason).toBe("forbidden");
  });

  it("приглашение принимается один раз и не старше суток", async () => {
    const fleet = newFleet(), yuri = await boot(fleet);
    const inv = ((await ask(fleet, yuri, { type: "invite", addr: "phone" + YURI })).result as { invite: string; kid: string });
    // приглашение — ещё не пропуск
    expect(await api.who(inv.invite)).toMatchObject({ error: "bad_key" });
    const key = await redeem(inv.invite);
    expect(await api.who(key)).toMatchObject({ addr: "phone" + YURI });
    expect(await api.fleetCall("", null, { type: "redeem", id: "r", invite: inv.invite })).toMatchObject({ ok: false, error: "bad_invite" });
    const old = ((await ask(fleet, yuri, { type: "invite", addr: "tablet" + YURI })).result as { invite: string; kid: string });
    await runInDurableObject(fleetStub(E, fleet), (_o, state) => {
      state.storage.sql.exec("UPDATE passes SET at = at - ? WHERE kid = ?", 25 * 60 * 60 * 1000, old.kid);
    });
    expect(await api.fleetCall("", null, { type: "redeem", id: "r", invite: old.invite })).toMatchObject({ ok: false, error: "bad_invite" });
    // у адреса с живым пропуском второго не бывает
    expect(await ask(fleet, yuri, { type: "invite", addr: "phone" + YURI })).toMatchObject({ ok: false, error: "name_taken" });
  });

  it("своё приглашает любой, чужое и нового человека — админ", async () => {
    const fleet = newFleet(), yuri = await boot(fleet), anya = await pass(fleet, yuri, "pult" + ANYA);
    expect((await ask(fleet, anya, { type: "invite", addr: "phone" + ANYA })).ok).toBe(true);
    expect((await ask(fleet, anya, { type: "invite", addr: "@anya-pc" })).ok).toBe(true);
    expect(await ask(fleet, anya, { type: "invite", addr: "pult" + OLEG })).toMatchObject({ ok: false, error: "forbidden" });
    expect(await ask(fleet, anya, { type: "invite", addr: "@x", owner: YURI })).toMatchObject({ ok: false, error: "forbidden" });
    expect(await ask(fleet, anya, { type: "invite", addr: "site@laptop" })).toMatchObject({ ok: false, error: "bad_input" });
    // пропуска: свои; у админа — все
    const mine = ((await ask(fleet, anya, { type: "passes" })).result as { passes: Array<{ person: string }> }).passes;
    expect(mine.length).toBe(3);
    expect(mine.every((p) => p.person === ANYA)).toBe(true);
    expect(((await ask(fleet, yuri, { type: "passes" })).result as { passes: unknown[] }).passes.length).toBe(4);
  });

  it("не админ на people.set — forbidden; админ меняет людей и проекты", async () => {
    const fleet = newFleet(), yuri = await boot(fleet), anya = await pass(fleet, yuri, "pult" + ANYA);
    expect(await ask(fleet, anya, { type: "people.set", person: ANYA, admin: true })).toMatchObject({ ok: false, error: "forbidden" });
    expect(await ask(fleet, anya, { type: "project.set", project: "site", name: "Сайт" })).toMatchObject({ ok: false, error: "forbidden" });
    expect((await ask(fleet, yuri, { type: "project.set", project: "site", name: "Сайт", members: [YURI] })).ok).toBe(true);
    expect((await ask(fleet, yuri, { type: "people.set", person: ANYA, name: "Аня", projects: ["site"] })).ok).toBe(true);
    expect(await ask(fleet, yuri, { type: "people.set", person: ANYA, projects: ["нет"] })).toMatchObject({ ok: false, error: "not_found" });
    const list = (await ask(fleet, anya, { type: "people.list" })).result as { people: Array<{ person: string; name?: string; admin: boolean; projects: string[] }>; projects: Array<{ id: string; members: string[] }> };
    expect(list.people.find((p) => p.person === ANYA)).toMatchObject({ name: "Аня", admin: false, projects: ["site"] });
    expect(list.projects).toHaveLength(1);
    expect(list.projects[0]).toMatchObject({ id: "site", name: "Сайт" });
    expect([...list.projects[0]!.members].sort()).toEqual([ANYA, YURI]);
    expect(await ask(fleet, anya, { type: "whoami" })).toMatchObject({ ok: true, result: { addr: "pult" + ANYA, person: ANYA, admin: false, fleet } });
    expect(await ask(fleet, yuri, { type: "session.open" })).toMatchObject({ ok: false, error: "unknown_request" });
    expect(await ask(fleet, yuri, { type: "revoke" })).toMatchObject({ ok: false, error: "bad_input" });
  });

  it("отзыв пропуска закрывает его соединения", async () => {
    const t = await trio();
    const h = await host(t.fleet, "laptop", t.laptop);
    h.send({ type: "machine.hello", build: 1, sessions: [row("site@laptop")] });
    const p = await page(t.fleet, t.anya), w = await watcher(t.fleet, "laptop", t.anya);
    await p.next((f) => f.type === "roster");
    w.send({ type: "session.watch", id: "w", to: "site@laptop" });
    await w.next((f) => f.type === "reply");
    const kid = t.anya.split(":")[1]!;
    // чужой пропуск отзывает только админ
    expect(await ask(t.fleet, t.oleg, { type: "revoke", kid })).toMatchObject({ ok: false, error: "forbidden" });
    expect((await ask(t.fleet, t.yuri, { type: "revoke", kid })).ok).toBe(true);
    expect((await p.closed).reason).toBe("revoked");
    expect((await w.closed).reason).toBe("revoked");
    expect(await api.who(t.anya)).toMatchObject({ error: "bad_key" });
    // отзыв пропуска машины: Host отключён, машины нет в картине
    const y = await page(t.fleet, t.yuri);
    await y.next((f) => f.type === "roster");
    expect((await ask(t.fleet, t.yuri, { type: "revoke", kid: t.laptop.split(":")[1]! })).ok).toBe(true);
    expect((await h.closed).reason).toBe("revoked");
    expect((await y.next((f) => f.type === "roster.delta" && !!f.gone)).gone).toEqual(["laptop"]);
    expect(names(await (await page(t.fleet, t.yuri)).next((f) => f.type === "roster"))).not.toContain("laptop");
  });

  it("смена проектов переподключает затронутых: новая картина — по новому доступу", async () => {
    const t = await trio();
    const a = await page(t.fleet, t.anya), w = await watcher(t.fleet, "laptop", t.anya);
    await a.next((f) => f.type === "roster");
    expect((await ask(t.fleet, t.yuri, { type: "people.set", person: ANYA, projects: [] })).ok).toBe(true);
    expect((await a.closed).reason).toBe("access");
    expect((await w.closed).reason).toBe("access");
    expect(names(await (await page(t.fleet, t.anya)).next((f) => f.type === "roster"))).toEqual(["anya-pc"]);
    expect((await (await watcher(t.fleet, "laptop", t.anya)).closed).reason).toBe("forbidden");
  });

  it("два флота не видят друг друга", async () => {
    const a = newFleet(), b = newFleet();
    const ka = await boot(a), kb = await boot(b, ANYA);
    await pass(a, ka, "@laptop");
    await pass(b, kb, "@laptop");
    await pass(a, ka, "@server");
    const hb = await host(b, "laptop", kb);
    expect((await hb.closed).reason).toBe("forbidden");
    // пропуск одного флота в другом не принят
    expect((await (await page(b, ka)).closed).reason).toBe("bad_key");
    expect(names(await (await page(a, ka)).next((f) => f.type === "roster"))).toEqual(["laptop", "server"]);
    expect(names(await (await page(b, kb)).next((f) => f.type === "roster"))).toEqual(["laptop"]);
    expect((await api.machines(b)).map((m) => m.owner)).toEqual([ANYA]);
  });

  it("флот заводится один раз и только с секретом", async () => {
    const fleet = newFleet();
    const post = (auth: string, body: unknown) => SELF.fetch("https://p.test/boot", { method: "POST", headers: { authorization: auth }, body: JSON.stringify(body) });
    expect((await post("Bearer wrong", { fleet, person: YURI })).status).toBe(403);
    expect((await post("Bearer boot-secret", { fleet, person: "yuri" })).status).toBe(400);
    expect((await post("Bearer boot-secret", { fleet, person: YURI })).status).toBe(200);
    expect((await post("Bearer boot-secret", { fleet, person: ANYA })).status).toBe(409);
    expect(await (await SELF.fetch("https://p.test/health")).json()).toEqual({ ok: true, part: "platform" });
  });
});

describe("доставка", () => {
  it("deliver сессии возвращает ответ Host и отрезок в spans", async () => {
    const fleet = newFleet(), yuri = await boot(fleet), laptop = await pass(fleet, yuri, "@laptop");
    const seen: Frame[] = [];
    await host(fleet, "laptop", laptop, (f) => (seen.push(f), { result: { queued: true } }));
    const r = await api.deliver(fleet, { type: "message", id: "m-41", to: "site@laptop", from: "pult" + YURI, text: "Собери отчёт", trace: "t1" });
    expect(r).toMatchObject({ type: "reply", id: "m-41", ok: true, result: { queued: true }, trace: "t1" });
    expect(r!.spans!.map((s) => s.part)).toEqual(["host", "platform"]);
    expect(seen[0]).toMatchObject({ type: "message", to: "site@laptop", from: "pult" + YURI, text: "Собери отчёт", trace: "t1" });
    // отказ Host доходит словом
    await host(fleet, "laptop", laptop, () => ({ ok: false, error: "already_answered", result: undefined }));
    expect(await api.deliver(fleet, { type: "answer", id: "a-1", to: "site@laptop" })).toMatchObject({ ok: false, error: "already_answered" });
  });

  it("машина не на связи — offline", async () => {
    const fleet = newFleet(), yuri = await boot(fleet);
    await pass(fleet, yuri, "@laptop");
    expect(await api.deliver(fleet, { type: "message", id: "m-1", to: "site@laptop", text: "x" })).toMatchObject({ ok: false, error: "offline" });
    expect(await api.deliver(fleet, { type: "plan.changed", to: ".keeper@laptop" })).toBeNull();
    expect(await api.deliver(fleet, { type: "message", id: "m-2", to: "~a@b.c" })).toMatchObject({ ok: false, error: "bad_input" });
  });

  it("Host ушёл посреди запроса — ждущий получает offline", async () => {
    const fleet = newFleet(), yuri = await boot(fleet), laptop = await pass(fleet, yuri, "@laptop");
    // эта подделка Host на запросы не отвечает
    const silent = await connect("/m/" + fleet + "/laptop", laptop, "host");
    const waiting = api.deliver(fleet, { type: "message", id: "m-9", to: "site@laptop", text: "x" });
    await silent.next((f) => f.type === "message");
    silent.ws.close(1000, "bye");
    expect(await waiting).toMatchObject({ ok: false, error: "offline" });
  });

  it("соединение Host переживает усыпление объекта машины: доставка и ответ работают", async () => {
    // опыт: объект усыплён с открытым соединением, карточка соединения восстановлена, ответ возвращён
    const fleet = newFleet(), yuri = await boot(fleet), laptop = await pass(fleet, yuri, "@laptop");
    const h = await host(fleet, "laptop", laptop);
    h.send({ type: "machine.hello", build: 1, sessions: [] });
    const p = await page(fleet, yuri);
    await p.next((f) => f.type === "roster" && (f.machines as MachineRow[])[0]?.online === true || (f.type === "roster.delta" && (f.machines as MachineRow[] | undefined)?.[0]?.online === true));
    await evictDurableObject(machineStub(E, fleet, "laptop"));
    expect(await api.deliver(fleet, { type: "session.stop", id: "s-1", to: "site@laptop" })).toMatchObject({ ok: true, result: { got: "session.stop" } });
    // и уход Host после усыпления замечен
    h.ws.close(1000, "bye");
    await p.next((f) => f.type === "roster.delta" && (f.machines as MachineRow[] | undefined)?.[0]?.online === false);
  });

  it("кадр Host для сессии другой машины доходит до её Host и ответ возвращается", async () => {
    const t = await trio();
    const got: Frame[] = [];
    await host(t.fleet, "server", t.server, (f) => (got.push(f), { result: { queued: true } }));
    const hl = await host(t.fleet, "laptop", t.laptop);
    hl.send({ type: "message", id: "m-7", to: "docs@server", from: "site@laptop", text: "Обнови раздел", trace: "t7" });
    const r = await hl.next((f) => f.type === "reply" && f.id === "m-7");
    expect(r).toMatchObject({ ok: true, result: { queued: true }, trace: "t7" });
    expect((r.spans as Array<{ part: string }>).map((s) => s.part)).toEqual(["host", "platform", "platform"]);
    expect(got[0]).toMatchObject({ type: "message", to: "docs@server", from: "site@laptop", text: "Обнови раздел" });
    // отправителем Host может назвать только свою сессию
    hl.send({ type: "message", id: "m-8", to: "docs@server", from: "x@oleg-mac", text: "y" });
    await hl.next((f) => f.type === "reply" && f.id === "m-8");
    expect(got[1]).toMatchObject({ from: "@laptop" });
    // владелец машины не достаёт до адресата — forbidden; адресат не на связи — offline
    const ha = await host(t.fleet, "anya-pc", t.apc);
    ha.send({ type: "message", id: "m-9", to: "x@oleg-mac", text: "z" });
    expect(await ha.next((f) => f.type === "reply")).toMatchObject({ id: "m-9", ok: false, error: "forbidden" });
    ha.send({ type: "message", id: "m-10", to: "site@laptop", text: "z" });
    expect(await ha.next((f) => f.type === "reply" && f.id === "m-10")).toMatchObject({ ok: true });
    hl.send({ type: "message", id: "m-11", to: "x@oleg-mac", text: "z" });
    expect(await hl.next((f) => f.type === "reply" && f.id === "m-11")).toMatchObject({ ok: false, error: "offline" });
  });

  it("лента идёт зрителям по адресам; зритель ушёл — Host узнаёт", async () => {
    const t = await trio();
    const asked: Frame[] = [];
    const h = await host(t.fleet, "laptop", t.laptop, (f) => (asked.push(f), { result: { seq: 118 } }));
    const wa = await watcher(t.fleet, "laptop", t.anya), wy = await watcher(t.fleet, "laptop", t.yuri);
    wa.send({ type: "session.watch", id: "w1", to: "site@laptop", trace: "tw" });
    const r = await wa.next((f) => f.type === "reply");
    expect(r).toMatchObject({ id: "w1", ok: true, result: { seq: 118 }, trace: "tw" });
    expect((r.spans as Array<{ part: string }>).map((s) => s.part)).toEqual(["host", "platform"]);
    expect(asked[0]).toMatchObject({ type: "session.watch", to: "site@laptop", from: "pult" + ANYA });
    wy.send({ type: "session.read", id: "w2", to: "site@laptop" });
    await wy.next((f) => f.type === "reply");
    // этим соединением идут только запросы зрителя сессиям этой машины
    wa.send({ type: "session.stop", id: "w3", to: "site@laptop" });
    expect(await wa.next((f) => f.type === "reply")).toMatchObject({ id: "w3", ok: false, error: "unknown_request" });
    wa.send({ type: "session.watch", id: "w4", to: "docs@server" });
    expect(await wa.next((f) => f.type === "reply")).toMatchObject({ id: "w4", ok: false, error: "unknown_request" });
    h.send({ type: "session.events", to: ["pult" + ANYA], callsign: "site@laptop", seq: 119, events: [{ type: "assistant" }] });
    expect(await wa.next((f) => f.type === "session.events")).toMatchObject({ callsign: "site@laptop", seq: 119 });
    h.send({ type: "session.events", to: ["pult" + YURI], callsign: "site@laptop", seq: 120, events: [] });
    await wy.next((f) => f.type === "session.events" && f.seq === 120);
    expect(wa.frames.some((f) => f.seq === 120)).toBe(false);
    wa.ws.close(1000, "bye");
    expect(await h.next((f) => f.type === "watcher.gone")).toMatchObject({ from: "pult" + ANYA });
  });

  it("рассылка доходит каждой машине на связи: Host или Keeper", async () => {
    const t = await trio();
    const hl = await host(t.fleet, "laptop", t.laptop), hs = await host(t.fleet, "server", t.server);
    const kl = await connect("/m/" + t.fleet + "/laptop", t.laptop, "keeper");
    const y = await page(t.fleet, t.yuri);
    await y.next((f) => f.type === "roster.delta" && (f.machines as MachineRow[] | undefined)?.[0]?.keeper === true || (f.type === "roster" && (f.machines as MachineRow[]).some((m) => m.keeper === true)));
    expect(await api.broadcast(t.fleet, { type: "changed", what: "proxy.rules", trace: "tb" }, "host")).toBe(2);
    expect(await hl.next((f) => f.type === "changed")).toMatchObject({ what: "proxy.rules", to: "@laptop", trace: "tb" });
    expect(await hs.next((f) => f.type === "changed")).toMatchObject({ to: "@server" });
    expect(await api.broadcast(t.fleet, { type: "plan.changed" }, "keeper")).toBe(1);
    expect(await kl.next((f) => f.type === "plan.changed")).toMatchObject({ to: ".keeper@laptop" });
    // запрос keeper идёт его соединением, а не Host
    const waiting = api.deliver(t.fleet, { type: "keeper.state", id: "k-1", to: ".keeper@laptop" });
    const q = await kl.next((f) => f.type === "keeper.state");
    kl.send({ type: "reply", id: q.id!, ok: true, result: { build: 412 } });
    expect(await waiting).toMatchObject({ ok: true, result: { build: 412 } });
  });

  it("на связи ли человек — по открытой странице", async () => {
    const fleet = newFleet(), yuri = await boot(fleet);
    expect(await api.online(fleet, YURI)).toBe(false);
    const p = await page(fleet, yuri);
    await p.next((f) => f.type === "roster");
    expect(await api.online(fleet, YURI)).toBe(true);
    expect(await api.online(fleet, ANYA)).toBe(false);
  });
});
