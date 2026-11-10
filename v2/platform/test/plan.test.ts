// Свойства плана тестов v2 без теста: заведение флота (отказы) и удаление человека.
// Источник — устав («система ловит»: отказ словом, ничего не изменено) и код («чьё: код»).
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Frame, MachineRow, SessionRow } from "@sb/protocol";
import { ANYA, api, ask, boot, connect, host, newFleet, OLEG, page, pass, row, trio, YURI } from "./kit.ts";

const names = (f: Frame) => ((f.machines as MachineRow[] | undefined) ?? []).map((m) => m.name).sort();

const post = async (body: unknown, secret = "boot-secret") => {
  const res = await SELF.fetch("https://p.test/boot", { method: "POST", headers: { authorization: "Bearer " + secret }, body: JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as { ok: boolean; error?: string } };
};

describe("заведение флота", () => {
  it("секрет неверный — forbidden, флот не заведён: верным секретом он заводится", async () => {
    const fleet = newFleet();
    expect(await post({ fleet, person: YURI }, "wrong-secret")).toMatchObject({ status: 403, json: { ok: false, error: "forbidden" } });
    expect(await post({ fleet, person: YURI })).toMatchObject({ status: 200, json: { ok: true } });
  });

  it("флот уже заведён — exists, прежний админ на месте", async () => {
    const fleet = newFleet(), yuri = await boot(fleet);
    expect(await post({ fleet, person: ANYA })).toMatchObject({ status: 409, json: { ok: false, error: "exists" } });
    const people = ((await ask(fleet, yuri, { type: "people.list" })).result as { people: Array<{ person: string }> }).people.map((p) => p.person);
    expect(people).toEqual([YURI]);
  });

  it("вход отклонён: тело не по форме — bad_input", async () => {
    expect(await post({ fleet: newFleet(), person: "yuri" })).toMatchObject({ status: 400, json: { ok: false, error: "bad_input" } });
  });
});

describe("удаление человека", () => {
  it("не админ — forbidden; такого человека нет — not_found", async () => {
    const fleet = newFleet(), yuri = await boot(fleet), anya = await pass(fleet, yuri, "pult" + ANYA);
    expect(await ask(fleet, anya, { type: "people.remove", person: YURI })).toMatchObject({ ok: false, error: "forbidden" });
    expect(await ask(fleet, yuri, { type: "people.remove", person: "~nobody@example.com" })).toMatchObject({ ok: false, error: "not_found" });
  });
});

describe("приглашения и пропуска", () => {
  // чьё: код
  it("повторное приглашение на тот же адрес заменяет непринятое: прежнее — bad_invite, новое принимается", async () => {
    const fleet = newFleet(), yuri = await boot(fleet);
    const first = ((await ask(fleet, yuri, { type: "invite", addr: "phone" + YURI })).result as { invite: string }).invite;
    const second = (await ask(fleet, yuri, { type: "invite", addr: "phone" + YURI })) as { ok: boolean; result: { invite: string } };
    expect(second.ok).toBe(true);
    expect(await api.fleetCall("", null, { type: "redeem", id: "r1", invite: first })).toMatchObject({ ok: false, error: "bad_invite" });
    expect(await api.fleetCall("", null, { type: "redeem", id: "r2", invite: second.result.invite })).toMatchObject({ ok: true });
  });

  // чьё: код — договор revoke: «отозвать пропуск или приглашение»
  it("отозванное непринятое приглашение не принимается — bad_invite", async () => {
    const fleet = newFleet(), yuri = await boot(fleet);
    const made = (await ask(fleet, yuri, { type: "invite", addr: "phone" + YURI })).result as { invite: string; kid: string };
    expect(await ask(fleet, yuri, { type: "revoke", kid: made.kid })).toMatchObject({ ok: true });
    expect(await api.fleetCall("", null, { type: "redeem", id: "r", invite: made.invite })).toMatchObject({ ok: false, error: "bad_invite" });
  });

  // устав: «система ловит» — отказ словом
  it("отзыв пропуска, которого нет, — not_found", async () => {
    const fleet = newFleet(), yuri = await boot(fleet);
    expect(await ask(fleet, yuri, { type: "revoke", kid: "nosuchkid0" })).toMatchObject({ ok: false, error: "not_found" });
  });

  // чьё: код
  it("принятая машина сразу видна открытой странице: строка с владельцем, без связи", async () => {
    const fleet = newFleet(), yuri = await boot(fleet);
    const p = await page(fleet, yuri);
    await p.next((f) => f.type === "roster");
    await pass(fleet, yuri, "@laptop");
    const d = await p.next((f) => f.type === "roster.delta" && !!f.machines);
    expect((d.machines as MachineRow[])[0]).toMatchObject({ name: "laptop", owner: YURI, online: false });
  });
});

describe("люди и проекты: кто что видит после правки", () => {
  // чьё: код
  it("человека убрали: его страница и Host его машины закрыты словом revoked, соседу по проекту — машина ушла и переподключение, в списке и проекте его нет", async () => {
    const t = await trio();
    expect(await ask(t.fleet, t.yuri, { type: "project.set", project: "pair", name: "pair", members: [ANYA, OLEG] })).toMatchObject({ ok: true });
    const a = await page(t.fleet, t.anya), o = await page(t.fleet, t.oleg), h = await host(t.fleet, "anya-pc", t.apc);
    await a.next((f) => f.type === "roster");
    await o.next((f) => f.type === "roster");
    expect(await ask(t.fleet, t.yuri, { type: "people.remove", person: ANYA })).toMatchObject({ ok: true });
    expect((await a.closed).reason).toBe("revoked");
    expect((await h.closed).reason).toBe("revoked");
    expect((await o.next((f) => f.type === "roster.delta" && !!f.gone)).gone).toEqual(["anya-pc"]);
    expect((await o.closed).reason).toBe("access");
    expect(await api.who(t.anya)).toMatchObject({ error: "bad_key" });
    const list = (await ask(t.fleet, t.yuri, { type: "people.list" })).result as { people: Array<{ person: string }>; projects: Array<{ id: string; members: string[] }> };
    expect(list.people.map((p) => p.person)).not.toContain(ANYA);
    expect(list.projects.find((p) => p.id === "pair")!.members).toEqual([OLEG]);
  });

  // чьё: код
  it("права админа даны: страница человека закрыта словом access, новая картина — все машины флота и you.admin", async () => {
    const t = await trio();
    const a = await page(t.fleet, t.anya);
    expect(names(await a.next((f) => f.type === "roster"))).toEqual(["anya-pc", "laptop", "server"]);
    expect(await ask(t.fleet, t.yuri, { type: "people.set", person: ANYA, admin: true })).toMatchObject({ ok: true });
    expect((await a.closed).reason).toBe("access");
    const r = await (await page(t.fleet, t.anya)).next((f) => f.type === "roster");
    expect(names(r)).toEqual(["anya-pc", "laptop", "oleg-mac", "server"]);
    expect(r.you).toMatchObject({ person: ANYA, admin: true });
  });

  // устав: «система ловит» — отказ словом, ничего не изменено
  it("project.remove не от админа — forbidden, проект на месте", async () => {
    const t = await trio();
    expect(await ask(t.fleet, t.anya, { type: "project.remove", project: "site" })).toMatchObject({ ok: false, error: "forbidden" });
    const list = (await ask(t.fleet, t.yuri, { type: "people.list" })).result as { projects: Array<{ id: string; members: string[] }> };
    expect(list.projects.find((p) => p.id === "site")!.members.sort()).toEqual([ANYA, YURI]);
  });

  // устав: «система ловит» — отказ словом
  it("project.set с участником не из флота — not_found: участники прежние, никто не переподключён", async () => {
    const t = await trio();
    const a = await page(t.fleet, t.anya);
    await a.next((f) => f.type === "roster");
    expect(await ask(t.fleet, t.yuri, { type: "project.set", project: "site", name: "site", members: [YURI, "~ghost@example.com"] })).toMatchObject({ ok: false, error: "not_found" });
    const list = (await ask(t.fleet, t.yuri, { type: "people.list" })).result as { projects: Array<{ id: string; members: string[] }> };
    expect(list.projects.find((p) => p.id === "site")!.members.sort()).toEqual([ANYA, YURI]);
    expect(await Promise.race([a.closed.then(() => "closed"), new Promise((r) => setTimeout(() => r("open"), 300))])).toBe("open");
  });
});

describe("соединение машины", () => {
  // факт: на живом флоте пропадал вопрос сессии — «ждёт» и вопрос приходят с разницей в миллисекунды
  it("изменения строк доходят в порядке прихода: в картине — последняя присланная строка с вопросом", async () => {
    const fleet = newFleet(), yuri = await boot(fleet), laptop = await pass(fleet, yuri, "@laptop");
    const h = await host(fleet, "laptop", laptop);
    h.send({ type: "machine.hello", build: 1, sessions: [row("site@laptop")] });
    const p = await page(fleet, yuri);
    await p.next((f) => f.type === "roster" || (f.type === "roster.delta" && !!f.sessions));
    const q = { id: "q-1", kind: "question", text: "Какую ветку?", at: 5 };
    // три изменения подряд, без ожидания между ними
    h.send({ type: "session.state", callsign: "site@laptop", row: { ...row("site@laptop"), state: "busy" } });
    h.send({ type: "session.state", callsign: "site@laptop", row: { ...row("site@laptop"), state: "waiting" } });
    h.send({ type: "session.state", callsign: "site@laptop", row: { ...row("site@laptop"), state: "waiting", ask: q } });
    const seen: string[] = [];
    for (;;) {
      const d = await p.next((f) => f.type === "roster.delta" && !!f.sessions);
      const r = (d.sessions as Array<{ row: SessionRow | null }>)[0]!.row!;
      seen.push(r.state + (r.ask ? "+ask" : ""));
      if (r.ask) break;
    }
    expect(seen).toEqual(["busy", "waiting", "waiting+ask"]);
    const fresh = await (await page(fleet, yuri)).next((f) => f.type === "roster");
    expect((fresh.sessions as SessionRow[])[0]).toMatchObject({ state: "waiting", ask: q });
  });

  // устав: закрытый список ожидаемых веток восстановления — соединение оборвалось, клиенты переподключаются
  it("соединение машины оборвалось: offline с временем, запрос к сессии — offline; Host вернулся — снова online и запрос доходит", async () => {
    const fleet = newFleet(), yuri = await boot(fleet), laptop = await pass(fleet, yuri, "@laptop");
    const h = await host(fleet, "laptop", laptop);
    h.send({ type: "machine.hello", build: 1, sessions: [row("site@laptop")] });
    const p = await page(fleet, yuri);
    const online = (f: Frame, on: boolean) => (f.machines as MachineRow[] | undefined)?.[0]?.online === on;
    await p.next((f) => (f.type === "roster" || f.type === "roster.delta") && online(f, true));
    h.ws.close(1000, "bye");
    const off = await p.next((f) => f.type === "roster.delta" && online(f, false));
    expect((off.machines as MachineRow[])[0]!.since).toEqual(expect.any(Number));
    expect(await api.deliver(fleet, { type: "message", id: "m-1", to: "site@laptop", text: "x" })).toMatchObject({ ok: false, error: "offline" });
    const back = await host(fleet, "laptop", laptop);
    back.send({ type: "machine.hello", build: 1, sessions: [row("site@laptop")] });
    await p.next((f) => f.type === "roster.delta" && online(f, true));
    expect(await api.deliver(fleet, { type: "message", id: "m-2", to: "site@laptop", text: "x" })).toMatchObject({ ok: true });
  });

  // устав: «у всех операций должен быть лимит»
  it("Host принял запрос и молчит дольше предела — отказ timeout, соединение цело", async () => {
    const fleet = newFleet(), yuri = await boot(fleet), laptop = await pass(fleet, yuri, "@laptop");
    const silent = await connect("/m/" + fleet + "/laptop", laptop, "host");
    const r = await api.deliver(fleet, { type: "message", id: "m-t", to: "site@laptop", text: "x" });
    expect(r).toMatchObject({ ok: false, error: "timeout" });
    expect(silent.ws.readyState).toBe(1);
  });
});
