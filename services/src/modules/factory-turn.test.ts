// Эталоны «Фабрики»: разговор сессии на границе тикетов — продолжается или начинается заново по правилу поста и предмету тикета (key);
// предмет у одной сессии поста по очереди; «стоп» платформы — тикетом надзирателю, остальное — людям; работу посту дают раздающие.
import { describe, expect, it } from "vitest";
import type { SessionRow, Ticket } from "@sb/protocol";
import type { Outside } from "../env.ts";
import { appliedFleet } from "../../test/factory.ts";
import type { Stand } from "../../test/stand.ts";
import { fire } from "./clock/clock.ts";
import { raise } from "./factory/contract.ts";
import { b64u } from "./reach/webpush.ts";

const POST = (extra: Record<string, unknown> = {}) => ({ at: "@laptop", cwd: "~/work/post", key: "claude", model: "claude-opus-5-5", for: "1d", ...extra });
/** Определение проекта «site»: coders — две сессии «по предмету», scout — «с чистого листа», cto — разговор продолжается (keep),
 *  pair — две сессии без правила разговора; правило losses зовут по имени. */
const DEF = {
  project: "site",
  posts: { coders: POST({ size: 2, context: "thread" }), scout: POST({ context: "fresh" }), cto: POST(), pair: POST({ size: 2 }) },
  on: [{ name: "losses", to: "coders", title: "Потери на ферме" }],
};
/** Определение ролей: правило stop идёт посту-надзирателю watch, вставшее без надзирателя — Юре. */
const ROLES = {
  project: "site", call: ["~yuri@example.com"],
  posts: { coders: POST({ size: 2, context: "thread" }), watch: POST() },
  on: [{ name: "stop", to: "watch" }],
};
const CH = { CH_URL: "https://ch.test:8443/" };
const applied = (def: unknown = DEF) => appliedFleet(def, CH);
const sent = (s: Stand, type: string) => s.seen.delivered.filter((f) => f.type === type);
const gives = (s: Stand) => sent(s, "work.give");
const one = async (s: Stand, id: string) => ((await s.ask("ticket.list", { ticket: id })).result as { tickets: Ticket[] }).tickets[0]!;
const list = async (s: Stand, fields: Record<string, unknown>) => ((await s.ask("ticket.list", { project: "site", ...fields })).result as { tickets: Ticket[] }).tickets;
const outside = (s: Stand): Outside => ({ platform: s.platform, fetch: s.deps.fetch!, log: { info() {}, warn() {}, error() {}, with() { return this; } } as never });
/** Запрос от имени сессии машины laptop. */
const as = (s: Stand, callsign: string, type: string, fields: Record<string, unknown>) => s.ask(type, fields, "klaptop", callsign);
const make = async (s: Stand, to: string, title: string, extra: Record<string, unknown> = {}) => ((await s.ask("ticket.new", { project: "site", to, title, ...extra })).result as { id: string }).id;
/** Тикет с предметом от человека. */
const about = (s: Stand, to: string, key: string, title = key) => make(s, to, title, { key });
/** Сработать по всем срокам часов флота до момента at. */
const tick = (s: Stand, at: number) => fire(s.env, s.fleet, outside(s), at);
/** Строки истории «ticket», которые записали службы: вид движения и данные. */
const ticketLines = (s: Stand): Record<string, unknown>[] =>
  s.seen.net
    .filter((n) => n.url.startsWith(CH.CH_URL) && String(n.init?.body ?? "").includes('"msg":"ticket"'))
    .map((n) => {
      const row = JSON.parse(String(n.init!.body)) as { kind: string; data: string };
      return { kind: row.kind, ...(JSON.parse(row.data) as Record<string, unknown>) };
    });
/** Последняя выдача тикета: кадр work.give. */
const lastGive = (s: Stand, id: string) => gives(s).filter((g) => g.ticket === id).at(-1)!;
const done = (s: Stand, callsign: string, ticket: string) => as(s, callsign, "ticket.set", { ticket, verdict: "done" });
/** Усыпить тикет на 40 минут и разбудить его сроком часов. */
const nap = async (s: Stand, callsign: string, ticket: string) => as(s, callsign, "ticket.set", { ticket, in: "40m" });
const wakeBy = async (s: Stand, ticket: string) => expect(await tick(s, (await one(s, ticket)).start!)).toBeGreaterThan(0);

/* ===== Зов людей: веб-пуш на устройство Юры ===== */

const ENDPOINT = "https://push.example/sub/yuri";
async function vapidKey(): Promise<string> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"])) as CryptoKeyPair;
  return JSON.stringify(await crypto.subtle.exportKey("jwk", pair.privateKey));
}
/** Флот с определением ролей и подпиской Юры на пуши: каждый зов людей — один запрос на его адрес. */
async function roles(def: unknown = ROLES) {
  const got = await appliedFleet(def, { ...CH, VAPID_PRIVATE: await vapidKey() });
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const p256dh = b64u(new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer));
  expect(await got.s.ask("reach.subscribe", { kind: "webpush", endpoint: ENDPOINT, p256dh, auth: b64u(crypto.getRandomValues(new Uint8Array(16))) })).toMatchObject({ ok: true });
  return got;
}
/** Сколько раз позвали людей проекта. */
const calls = (s: Stand) => s.seen.net.filter((n) => n.url === ENDPOINT).length;
/** Тикеты надзирателя. */
const watchTickets = (s: Stand) => list(s, { to: "watch" });

describe("фабрика: разговор на границе тикетов", () => {
  // эталон 41 — чьё: слово пользователя 27 нояб. — «в похожих задачах продолжать»
  it("41 · тот же предмет — тот же разговор: сдала «план боя», следующий «план боя» уходит ей без clear; первый тикет разговора — с clear", async () => {
    const { s } = await applied();
    const busy = await about(s, "coders", "порталы");
    const t1 = await about(s, "coders", "план боя");
    expect(await one(s, busy)).toMatchObject({ session: "coders@laptop" });
    expect(await one(s, t1)).toMatchObject({ session: "coders-2@laptop" });
    expect(lastGive(s, t1)).toMatchObject({ name: "coders-2", clear: true });
    await done(s, "coders-2@laptop", t1);
    const t2 = await about(s, "coders", "план боя", "План боя: второй срез");
    expect(await one(s, t2)).toMatchObject({ state: "work", session: "coders-2@laptop" });
    expect(lastGive(s, t2)).toMatchObject({ name: "coders-2", key: "план боя" });
    expect(lastGive(s, t2).clear).toBeUndefined();
  });

  // эталон 42 — чьё: слово пользователя 27 нояб. — «в разных сбрасывать контекст»
  it("42 · другой предмет — заново: после «план боя» тикет «порталы» уходит с clear: true; строка истории given несёт clear и key", async () => {
    const { s } = await applied();
    const t1 = await about(s, "coders", "план боя");
    await done(s, "coders@laptop", t1);
    const t2 = await about(s, "coders", "порталы");
    expect(await one(s, t2)).toMatchObject({ state: "work", session: "coders@laptop" });
    expect(lastGive(s, t2)).toMatchObject({ name: "coders", key: "порталы", clear: true });
    expect(ticketLines(s).filter((l) => l.kind === "given" && l.ticket === t2)).toMatchObject([{ clear: true, key: "порталы" }]);
  });

  // эталон 43 — чьё: факт — диспетчер читал 490 К истории на вызов
  it("43 · с чистого листа — каждый тикет: у поста fresh второй тикет того же предмета — с clear; у поста без context clear нет никогда", async () => {
    const { s } = await applied();
    const a = await about(s, "scout", "план боя");
    await done(s, "scout@laptop", a);
    const b = await about(s, "scout", "план боя");
    expect(await one(s, b)).toMatchObject({ state: "work", session: "scout@laptop" });
    expect(lastGive(s, b)).toMatchObject({ name: "scout", clear: true });
    // keep: ни первый, ни тот же предмет, ни другой
    const c = await about(s, "cto", "план боя");
    await done(s, "cto@laptop", c);
    const d = await about(s, "cto", "план боя");
    await done(s, "cto@laptop", d);
    const e = await about(s, "cto", "порталы");
    expect(await one(s, e)).toMatchObject({ state: "work", session: "cto@laptop" });
    const cto = gives(s).filter((g) => g.name === "cto");
    expect(cto.map((g) => g.ticket)).toEqual([c, d, e]);
    for (const g of cto) expect(g.clear).toBeUndefined();
  });

  // эталон 44 — чьё: код — возврат и проснувшийся тикет идут той же сессии
  it("44 · тот же тикет — тот же разговор: возврат человека без тикетов между уходит без clear у fresh и у thread; был другой тикет между — с clear", async () => {
    const { s } = await applied();
    for (const [post, session] of [["scout", "scout@laptop"], ["coders", "coders@laptop"]] as const) {
      const t = await about(s, post, "план боя");
      expect(lastGive(s, t)).toMatchObject({ clear: true });
      expect(await s.ask("ticket.set", { ticket: t, verdict: "back", note: "нет эталона" })).toMatchObject({ ok: true });
      expect(await one(s, t)).toMatchObject({ state: "work", session, returns: 1 });
      expect(gives(s).filter((g) => g.ticket === t)).toHaveLength(2);
      expect(String(lastGive(s, t).text)).toContain("Вернули с замечанием: нет эталона");
      expect(lastGive(s, t).clear).toBeUndefined();
      // между — тикет другого предмета: тот же тикет после него — заново
      await nap(s, session, t);
      const other = await about(s, post, "порталы");
      expect(await one(s, other)).toMatchObject({ state: "work", session });
      await done(s, session, other);
      expect(await s.ask("ticket.set", { ticket: t, resume: true })).toMatchObject({ ok: true });
      expect(await one(s, t)).toMatchObject({ state: "work", session });
      expect(gives(s).filter((g) => g.ticket === t)).toHaveLength(3);
      expect(lastGive(s, t)).toMatchObject({ clear: true });
    }
  });

  // эталон 45 — чьё: факт — опыт: после очистки в первом запросе модели прошлого нет
  it("45 · заново — со всеми заметками: выдача с clear несёт все заметки тикета; выдача без clear — только те, которых сессия не получала", async () => {
    const { s } = await applied();
    const t = await about(s, "coders", "план боя");
    expect(await one(s, t)).toMatchObject({ session: "coders@laptop" });
    await s.ask("ticket.set", { ticket: t, note: "первая заметка" });
    // проснулся без тикетов между: разговор тот же — первая заметка приходит впервые
    await nap(s, "coders@laptop", t);
    await wakeBy(s, t);
    expect(lastGive(s, t).clear).toBeUndefined();
    expect(String(lastGive(s, t).text)).toContain("Заметки к тикету (1):\n— pult~yuri@example.com: первая заметка");
    await s.ask("ticket.set", { ticket: t, note: "вторая заметка" });
    await nap(s, "coders@laptop", t);
    await wakeBy(s, t);
    const kept = lastGive(s, t);
    expect(kept.clear).toBeUndefined();
    expect(String(kept.text)).toContain("Заметки к тикету (1):\n— pult~yuri@example.com: вторая заметка");
    expect(String(kept.text)).not.toContain("первая заметка");
    // между — тикет другого предмета: разговор заново, тикет несёт все свои заметки
    await nap(s, "coders@laptop", t);
    const other = await about(s, "coders", "порталы");
    expect(await one(s, other)).toMatchObject({ state: "work", session: "coders@laptop" });
    await done(s, "coders@laptop", other);
    await wakeBy(s, t);
    expect(await one(s, t)).toMatchObject({ state: "work", session: "coders@laptop" });
    const fresh = lastGive(s, t);
    expect(fresh).toMatchObject({ clear: true });
    expect(String(fresh.text)).toContain("Заметки к тикету (2):\n— pult~yuri@example.com: первая заметка\n— pult~yuri@example.com: вторая заметка");
  });

  // эталон 46 — чьё: слово пользователя проекту — «срезы одного места — по очереди»
  it("46 · предмет называет тот, кто даёт работу: сессия без key посту thread — bad_input; человек, событие правила и пост без thread — приняты", async () => {
    const { s } = await applied();
    const refused = await as(s, "cto@laptop", "ticket.new", { project: "site", to: "coders", title: "Срез" });
    expect(refused).toMatchObject({ ok: false, error: "bad_input" });
    expect(refused.why).toContain("key");
    expect(await s.ask("ticket.new", { project: "site", to: "coders", title: "Срез" })).toMatchObject({ ok: true });
    const event = await as(s, "cto@laptop", "ticket.new", { project: "site", on: "losses", text: "потеряно 4 карты" });
    expect(event).toMatchObject({ ok: true });
    expect(await one(s, (event.result as { id: string }).id)).toMatchObject({ to: "coders", key: "losses", on: "losses" });
    expect(await as(s, "coders@laptop", "ticket.new", { project: "site", to: "cto", title: "Вопрос архитектуры" })).toMatchObject({ ok: true });
  });
});

describe("фабрика: предмет в очереди поста", () => {
  // эталон 47 — чьё: слово пользователя 27 нояб. — «в похожих задачах продолжать»
  it("47 · свой предмет — раньше старшего: свободная сессия берёт младший «план боя», а не старший «порталы»; срочный другого предмета — первым", async () => {
    const { s } = await applied();
    const a = await about(s, "coders", "план боя");
    const b = await about(s, "coders", "арена");
    expect(await one(s, a)).toMatchObject({ session: "coders@laptop" });
    expect(await one(s, b)).toMatchObject({ session: "coders-2@laptop" });
    const older = await about(s, "coders", "порталы");
    const mine = await about(s, "coders", "план боя", "План боя: второй срез");
    await done(s, "coders@laptop", a);
    expect(await one(s, mine)).toMatchObject({ state: "work", session: "coders@laptop" });
    expect(await one(s, older)).toMatchObject({ state: "ready" });
    // срочный другого предмета обходит и свой предмет, и старший
    const urgent = await make(s, "coders", "Срочно: башни", { key: "башни", first: true });
    const again = await about(s, "coders", "план боя", "План боя: третий срез");
    await done(s, "coders@laptop", mine);
    expect(await one(s, urgent)).toMatchObject({ state: "work", session: "coders@laptop" });
    expect(await one(s, again)).toMatchObject({ state: "ready" });
    expect(await one(s, older)).toMatchObject({ state: "ready" });
  });

  // эталон 48 — чьё: слово пользователя проекту — «срезы одного места — по очереди»
  it("48 · предмет в работе — у одной сессии: вторая берёт «порталы», «план боя» ждёт; сдал, усыпил или встал — выдаётся; свой спящий ждёт тоже; без thread замка нет", async () => {
    const { s } = await applied();
    const a = await about(s, "coders", "план боя");
    const b = await about(s, "coders", "план боя", "План боя: второй срез");
    const c = await about(s, "coders", "порталы");
    expect(await one(s, a)).toMatchObject({ state: "work", session: "coders@laptop" });
    expect(await one(s, b)).toMatchObject({ state: "ready" });
    expect(await one(s, c)).toMatchObject({ state: "work", session: "coders-2@laptop" });
    await done(s, "coders-2@laptop", c);
    expect(await one(s, b)).toMatchObject({ state: "ready" });
    // сдал — выдаётся
    await done(s, "coders@laptop", a);
    expect(await one(s, b)).toMatchObject({ state: "work", session: "coders@laptop" });
    // усыпил — выдаётся
    const d = await about(s, "coders", "план боя", "План боя: третий срез");
    expect(await one(s, d)).toMatchObject({ state: "ready" });
    await nap(s, "coders@laptop", b);
    expect(await one(s, d)).toMatchObject({ state: "work" });
    // встал — выдаётся
    const e = await about(s, "coders", "план боя", "План боя: четвёртый срез");
    expect(await one(s, e)).toMatchObject({ state: "ready" });
    expect(await as(s, (await one(s, d)).session!, "ticket.set", { ticket: d, verdict: "stop", note: "нужен доступ" })).toMatchObject({ ok: true, result: { state: "stop" } });
    expect(await one(s, e)).toMatchObject({ state: "work" });

    // свой проснувшийся: предмет в работе у другой сессии поста — тикет ждёт
    const { s: s2 } = await applied();
    const x = await about(s2, "coders", "план боя");
    await nap(s2, "coders@laptop", x);
    const z = await about(s2, "coders", "порталы");
    expect(await one(s2, z)).toMatchObject({ session: "coders@laptop" });
    const y = await about(s2, "coders", "план боя", "План боя: второй срез");
    expect(await one(s2, y)).toMatchObject({ state: "work", session: "coders-2@laptop" });
    await done(s2, "coders@laptop", z);
    expect(await s2.ask("ticket.set", { ticket: x, resume: true })).toMatchObject({ ok: true, result: { state: "ready" } });
    expect(await one(s2, x)).toMatchObject({ state: "ready" });
    await done(s2, "coders-2@laptop", y);
    expect(await one(s2, x)).toMatchObject({ state: "work", session: "coders@laptop" });

    // без thread: тикеты одного предмета у двух сессий разом
    const p = await about(s2, "pair", "план боя");
    const q = await about(s2, "pair", "план боя", "План боя: второй срез");
    expect(await one(s2, p)).toMatchObject({ state: "work", session: "pair@laptop" });
    expect(await one(s2, q)).toMatchObject({ state: "work", session: "pair-2@laptop" });
  });

  // эталон 49 — чьё: факт — группа срезов шла одним тикетом на 30 часов (слова СТО проекта)
  it("49 · все тикеты предмета — одним списком: ticket.list {key} отдаёт тикеты предмета в любых состояниях и не отдаёт чужих", async () => {
    const { s } = await applied();
    const a = await about(s, "coders", "план боя");
    await done(s, "coders@laptop", a);
    const b = await about(s, "coders", "план боя", "План боя: второй срез");
    const c = await about(s, "coders", "план боя", "План боя: третий срез");
    await about(s, "coders", "порталы");
    await make(s, "cto", "Без предмета");
    const rows = await list(s, { key: "план боя" });
    expect(rows.map((t) => [t.id, t.state])).toEqual([[c, "ready"], [b, "work"], [a, "done"]]);
  });
});

describe("фабрика: надзиратель и люди", () => {
  // эталон 50 — чьё: слово пользователя 27 нояб. — «роли надзирателя и дизайнера процессуально закрепить»
  it("50 · «стоп» платформы — тикет надзирателю: срок вышел или «стоп» машины — тикет посту watch с on: stop и key = номер; людей не зовут; resume надзирателя — той же сессии", async () => {
    const { s } = await roles();
    const t = await about(s, "coders", "план боя");
    expect(await one(s, t)).toMatchObject({ state: "work", session: "coders@laptop" });
    expect(await tick(s, (await one(s, t)).until!)).toBeGreaterThan(0);
    expect(await one(s, t)).toMatchObject({ state: "stop", why: "срок вышел" });
    expect((await watchTickets(s)).map((w) => [w.on, w.key])).toEqual([["stop", t]]);
    expect(calls(s)).toBe(0);
    const stopped = (await list(s, { state: "stop" })).find((x) => x.id === t)!;
    expect(stopped.human).toBeUndefined();
    expect(await as(s, "watch@laptop", "ticket.set", { ticket: t, resume: true })).toMatchObject({ ok: true });
    expect(await one(s, t)).toMatchObject({ state: "work", session: "coders@laptop" });
    expect(lastGive(s, t)).toMatchObject({ name: "coders" });
    // «стоп» от машины сессии
    const u = await about(s, "coders", "порталы");
    expect(await one(s, u)).toMatchObject({ state: "work", session: "coders-2@laptop" });
    expect(await s.ask("ticket.set", { ticket: u, verdict: "stop", note: "сессия упала" }, "klaptop")).toMatchObject({ ok: true, result: { state: "stop" } });
    expect((await watchTickets(s)).map((w) => [w.on, w.key])).toEqual([["stop", u], ["stop", t]]);
    expect(calls(s)).toBe(0);
    expect((await list(s, { state: "stop" })).find((x) => x.id === u)!.human).toBeUndefined();
    expect(await as(s, "watch@laptop", "ticket.set", { ticket: u, resume: true })).toMatchObject({ ok: true });
    expect(await one(s, u)).toMatchObject({ state: "work", session: "coders-2@laptop" });
  });

  // эталон 51 — чьё: слово пользователя 2 нояб. — у всех операций есть лимит
  it("51 · человеку: «стоп» сессии, вставший тикет надзирателя, второй «стоп» после закрытого тикета надзирателя; без правила stop — каждый «стоп»", async () => {
    // (а) «стоп» по слову самой сессии
    {
      const { s } = await roles();
      const t = await about(s, "coders", "план боя");
      expect(await as(s, "coders@laptop", "ticket.set", { ticket: t, verdict: "stop", note: "нужен доступ владельца" })).toMatchObject({ ok: true, result: { state: "stop" } });
      expect(calls(s)).toBe(1);
      expect(await watchTickets(s)).toEqual([]);
      expect(await one(s, t)).toMatchObject({ state: "stop", human: true });
    }
    // (б) встал тикет самого надзирателя
    {
      const { s } = await roles();
      const t = await about(s, "coders", "план боя");
      await tick(s, (await one(s, t)).until!);
      const [w] = await watchTickets(s);
      expect(await one(s, w!.id)).toMatchObject({ state: "work", session: "watch@laptop" });
      expect(calls(s)).toBe(0);
      await tick(s, (await one(s, w!.id)).until!);
      expect(await one(s, w!.id)).toMatchObject({ state: "stop", why: "срок вышел" });
      expect(calls(s)).toBe(1);
      expect((await watchTickets(s)).map((x) => x.id)).toEqual([w!.id]);
    }
    // (в) встал второй раз после того, как надзиратель вернул его и закрыл свой тикет
    {
      const { s } = await roles();
      const t = await about(s, "coders", "план боя");
      await tick(s, (await one(s, t)).until!);
      const [w] = await watchTickets(s);
      await as(s, "watch@laptop", "ticket.set", { ticket: t, resume: true });
      expect(await done(s, "watch@laptop", w!.id)).toMatchObject({ ok: true, result: { state: "done" } });
      expect(await one(s, t)).toMatchObject({ state: "work", session: "coders@laptop" });
      expect(calls(s)).toBe(0);
      await tick(s, (await one(s, t)).until!);
      expect(await one(s, t)).toMatchObject({ state: "stop", human: true });
      expect(calls(s)).toBe(1);
      expect((await watchTickets(s)).map((x) => x.id)).toEqual([w!.id]);
    }
    // правила stop нет — людей зовёт и «стоп» платформы
    {
      const { s } = await roles({ ...ROLES, on: [] });
      const t = await about(s, "coders", "план боя");
      await tick(s, (await one(s, t)).until!);
      expect(await one(s, t)).toMatchObject({ state: "stop", why: "срок вышел", human: true });
      expect(calls(s)).toBe(1);
      expect(await watchTickets(s)).toEqual([]);
    }
  });
});

describe("фабрика: раздающие", () => {
  const GIVEN = {
    project: "site",
    posts: { coders: POST({ size: 2, givers: ["design"] }), design: POST(), cto: POST() },
    on: [{ name: "losses", to: "coders", title: "Потери на ферме" }],
  };

  // эталон 52 — чьё: слово пользователя проекту — «всё через дизайнера»
  it("52 · работу исполнителю даёт раздающий: сессия cto — not_giver с именем design; design, человек и событие правила — приняты; передача не от раздающего — not_giver; givers без поста — bad_factory", async () => {
    const { s, file } = await applied(GIVEN);
    const refused = await as(s, "cto@laptop", "ticket.new", { project: "site", to: "coders", title: "Находка CTO" });
    expect(refused).toMatchObject({ ok: false, error: "not_giver" });
    expect(refused.why).toContain("design");
    expect(await as(s, "design@laptop", "ticket.new", { project: "site", to: "coders", title: "Срез от дизайнера" })).toMatchObject({ ok: true });
    expect(await s.ask("ticket.new", { project: "site", to: "coders", title: "От человека" })).toMatchObject({ ok: true });
    expect(await as(s, "cto@laptop", "ticket.new", { project: "site", on: "losses", text: "потеряно 4 карты" })).toMatchObject({ ok: true });
    // передача тикета в работе посту с раздающими от сессии не из них
    const x = await make(s, "cto", "Вопрос архитектуры");
    expect(await one(s, x)).toMatchObject({ state: "work", session: "cto@laptop" });
    const moved = await as(s, "cto@laptop", "ticket.set", { ticket: x, to: "coders" });
    expect(moved).toMatchObject({ ok: false, error: "not_giver" });
    expect(moved.why).toContain("design");
    expect(await one(s, x)).toMatchObject({ state: "work", to: "cto", session: "cto@laptop" });
    // раздающий, которого нет среди постов, — определение не применяется
    file.text = JSON.stringify({ ...GIVEN, posts: { ...GIVEN.posts, coders: POST({ size: 2, givers: ["nobody"] }) } });
    file.sha = "c2";
    const r = await s.ask("factory.apply", { project: "site", repo: "team/roles" });
    expect(r).toMatchObject({ ok: false, error: "bad_factory" });
    expect(r.why).toContain("givers");
  });

  // эталон 53 — чьё: код — тикет самой себе заменяет сессии таймер; комментарии к сайту приходят тикетом от службы
  it("53 · себе и от службы — без раздающего: сессия поста с givers заводит тикет себе; служба .sites — посту с givers", async () => {
    const def = { project: "site", posts: { coders: POST({ size: 2, context: "thread", givers: ["design"] }), design: POST() } };
    const { s } = await applied(def);
    const row = (callsign: string): SessionRow => ({ callsign, state: "idle", spec: { name: callsign.split("@")[0]!, cwd: "~/work/coders", project: "site" }, by: "~yuri@example.com", since: 1 });
    s.state.sessions = ["coders@laptop", "coders-2@laptop", "design@laptop"].map(row);
    // своему посту — не себе: раздаёт design
    expect(await as(s, "coders@laptop", "ticket.new", { project: "site", to: "coders", title: "Срез", key: "план боя" })).toMatchObject({ ok: false, error: "not_giver" });
    const self = await as(s, "coders@laptop", "ticket.new", { project: "site", to: "coders@laptop", title: "Проверить выкладку", for: "2h", in: "40m", key: "план боя" });
    expect(self).toMatchObject({ ok: true });
    expect(await one(s, (self.result as { id: string }).id)).toMatchObject({ state: "wait", to: "coders@laptop", key: "план боя" });
    const { id } = await raise(s.env, outside(s), s.fleet, { project: "site", to: "coders", title: "Комментарии к сайту map · 2", text: "две метки", by: ".sites", trace: "t-sites" });
    expect(await one(s, id)).toMatchObject({ to: "coders", by: ".sites", state: "work", session: "coders@laptop" });
  });
});
