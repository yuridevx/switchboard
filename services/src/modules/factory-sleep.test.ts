// Эталоны «Фабрики»: сон тикета — ждёт итога названных тикетов или срока, будит первое, заметка не будит; срочный тикет впереди старших;
// проверка поста у тикета в работе; определение убирает лишние сессии постов; строка списка без текста; числа очереди; круг ожидания.
import { describe, expect, it } from "vitest";
import type { FactoryState, SessionRow, Ticket } from "@sb/protocol";
import type { Outside } from "../env.ts";
import { appliedFleet } from "../../test/factory.ts";
import type { Stand } from "../../test/stand.ts";
import { fire } from "./clock/clock.ts";

const POST = (extra: Record<string, unknown> = {}) => ({ at: "@laptop", cwd: "~/work/post", key: "claude", model: "claude-opus-5-5", for: "1d", ...extra });
/** Определение проекта «site»: пост cto из одной сессии и пост coders из двух со сроком тикета неделя; правило losses зовут по имени. */
const DEF = {
  project: "site",
  posts: { cto: POST(), coders: POST({ size: 2, cwd: "~/work/coders", for: "7d" }) },
  on: [{ name: "losses", to: "coders", title: "Потери на ферме" }],
};

const CH = { CH_URL: "https://ch.test:8443/" };
const applied = (def: unknown = DEF) => appliedFleet(def, CH);
const sent = (s: Stand, type: string) => s.seen.delivered.filter((f) => f.type === type);
const gives = (s: Stand) => sent(s, "work.give");
const one = async (s: Stand, id: string) => ((await s.ask("ticket.list", { ticket: id })).result as { tickets: Ticket[] }).tickets[0]!;
const outside = (s: Stand): Outside => ({ platform: s.platform, fetch: s.deps.fetch!, log: { info() {}, warn() {}, error() {}, with() { return this; } } as never });
/** Запрос от имени сессии машины laptop. */
const as = (s: Stand, callsign: string, type: string, fields: Record<string, unknown>) => s.ask(type, fields, "klaptop", callsign);
const make = async (s: Stand, to: string, title: string, extra: Record<string, unknown> = {}) => ((await s.ask("ticket.new", { project: "site", to, title, ...extra })).result as { id: string }).id;
/** Тикет, заведённый сессией: со своего тикета в работе он помнит его. */
const makeAs = async (s: Stand, callsign: string, to: string, title: string) => ((await as(s, callsign, "ticket.new", { project: "site", to, title })).result as { id: string }).id;
/** Сработать по всем срокам часов флота до момента at. */
const tick = (s: Stand, at: number) => fire(s.env, s.fleet, outside(s), at);
const load = async (s: Stand) => ((await s.ask("factory.get", { project: "site" })).result as { factory: FactoryState }).factory.load;
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
/** Заметки службы в тикете: итоги чужих тикетов. */
const factoryNotes = async (s: Stand, id: string) => (await one(s, id)).notes!.filter((n) => n.by === ".factory").map((n) => n.text);

describe("фабрика: тикет ждёт другие тикеты", () => {
  // эталон 30 — чьё: факт — журнал прода 20–26 нояб. 2026: 252 отсрочки кодеров из 358 ждали чужую работу по таймеру
  it("30 · тикет ждёт другой тикет: спит, сессия берёт следующий; «сдал» блокера — тикет у той же сессии с итогом; заметка-итог одна, хотя ждущий сам завёл блокер", async () => {
    const { s } = await applied();
    const waiter = await make(s, "cto", "Двенадцатый");
    const next = await make(s, "cto", "Следующий");
    const blocker = await makeAs(s, "cto@laptop", "coders", "Блокер");
    expect(await one(s, blocker)).toMatchObject({ parent: waiter, state: "work", session: "coders@laptop" });
    expect(await as(s, "cto@laptop", "ticket.set", { ticket: waiter, after: [blocker], note: "жду блокер" })).toMatchObject({ ok: true, result: { state: "wait" } });
    const slept = await one(s, waiter);
    expect(slept).toMatchObject({ state: "wait", after: [blocker] });
    expect(slept.session).toBeUndefined();
    // сессия свободна — взяла следующий из очереди поста
    expect(await one(s, next)).toMatchObject({ state: "work", session: "cto@laptop" });
    await as(s, "cto@laptop", "ticket.set", { ticket: next, verdict: "done" });
    expect(await one(s, waiter)).toMatchObject({ state: "wait" });
    // блокер сдан — ждущий у той же сессии, итог в выдаче
    await as(s, "coders@laptop", "ticket.set", { ticket: blocker, verdict: "done", note: "граница по контракту" });
    const woke = await one(s, waiter);
    expect(woke).toMatchObject({ state: "work", session: "cto@laptop" });
    expect(woke.after).toBeUndefined();
    expect(String(lastGive(s, waiter).text)).toContain(`${blocker} сдан: граница по контракту`);
    expect(lastGive(s, waiter)).toMatchObject({ name: "cto" });
    expect(await factoryNotes(s, waiter)).toEqual([`${blocker} сдан: граница по контракту`]);
    expect(ticketLines(s).filter((l) => l.kind === "wake")).toMatchObject([{ ticket: waiter, from: blocker }]);
    // итог названного уже есть — ждать нечего: тикет сразу у своей сессии
    expect(await as(s, "cto@laptop", "ticket.set", { ticket: waiter, after: [blocker] })).toMatchObject({ ok: true, result: { state: "ready" } });
    expect(await one(s, waiter)).toMatchObject({ state: "work", session: "cto@laptop" });
  });

  // эталон 31 — чьё: факт — 26 нояб. 67 срезов сняты со словами «вошло в…»
  it("31 · снятый блокер тоже будит: блокер снят со словами «вошло в 15» — ждущий у своей сессии, в выдаче «снят»", async () => {
    const { s } = await applied();
    const waiter = await make(s, "cto", "Двенадцатый");
    const blocker = await make(s, "coders", "Срез");
    await as(s, "cto@laptop", "ticket.set", { ticket: waiter, after: [blocker] });
    expect(await s.ask("ticket.set", { ticket: blocker, drop: true, note: "вошло в 15" })).toMatchObject({ ok: true, result: { state: "done" } });
    expect(await one(s, waiter)).toMatchObject({ state: "work", session: "cto@laptop" });
    expect(String(lastGive(s, waiter).text)).toContain(`${blocker} снят: вошло в 15`);
  });

  // эталон 32 — чьё: слово пользователя 2 нояб. — у всех операций есть лимит
  it("32 · вставший блокер тоже будит: срок блокера вышел — ждущий у своей сессии с заметкой «встал: срок вышел»", async () => {
    const { s } = await applied();
    const waiter = await make(s, "cto", "Двенадцатый");
    const blocker = await make(s, "coders", "Срез");
    await as(s, "cto@laptop", "ticket.set", { ticket: waiter, after: [blocker] });
    const until = (await one(s, blocker)).until!;
    expect(await tick(s, until - 1)).toBe(0);
    expect(await one(s, waiter)).toMatchObject({ state: "wait" });
    expect(await tick(s, until)).toBe(1);
    expect(await one(s, blocker)).toMatchObject({ state: "stop", why: "срок вышел" });
    expect(await one(s, waiter)).toMatchObject({ state: "work", session: "cto@laptop" });
    expect(await factoryNotes(s, waiter)).toEqual([`${blocker} встал: срок вышел`]);
    expect(String(lastGive(s, waiter).text)).toContain(`${blocker} встал: срок вышел`);
  });

  // эталон 33 — чьё: код — отсрочка in
  it("33 · будит первое событие: ждёт блокер не дольше 2d; срок пришёл раньше итога — тикет у своей сессии, ожидания нет; поздний итог только заметкой заведшему", async () => {
    const { s } = await applied();
    const waiter = await make(s, "cto", "Двенадцатый");
    const blocker = await makeAs(s, "cto@laptop", "coders", "Срез");
    await as(s, "cto@laptop", "ticket.set", { ticket: waiter, after: [blocker], in: "2d" });
    const slept = await one(s, waiter);
    expect(slept).toMatchObject({ state: "wait", after: [blocker] });
    expect(slept.start! - Date.now()).toBeGreaterThan(1.99 * 86_400_000);
    expect(await tick(s, slept.start!)).toBe(1);
    const woke = await one(s, waiter);
    expect(woke).toMatchObject({ state: "work", session: "cto@laptop" });
    expect(woke.after).toBeUndefined();
    expect(woke.start).toBeUndefined();
    expect(await one(s, blocker)).toMatchObject({ state: "work" });
    const given = gives(s).filter((g) => g.ticket === waiter).length;
    // блокер сдан позже: ждущего он не трогает — второй побудки нет, итог заведшему идёт как обычно
    await as(s, "coders@laptop", "ticket.set", { ticket: blocker, verdict: "done", note: "готово" });
    expect(await one(s, waiter)).toMatchObject({ state: "work", session: "cto@laptop" });
    expect(gives(s).filter((g) => g.ticket === waiter)).toHaveLength(given);
    expect(ticketLines(s).filter((l) => l.kind === "wake" && l.ticket === waiter)).toHaveLength(1);
    expect(await factoryNotes(s, waiter)).toEqual([`${blocker} сдан: готово`]);
  });

  // эталон 34 — чьё: слово пользователя 26 нояб. («делай» по развилке «заметка не будит»)
  it("34 · заметка не будит: ни заметка человека, ни событие правила с тем же ключом; resume с заметкой — в очередь своей сессии, заметки приходят при выдаче", async () => {
    const { s } = await applied();
    const a = ((await s.ask("ticket.new", { project: "site", on: "losses", key: "map-7", text: "потеряно 4 карты" })).result as { id: string }).id;
    expect(await one(s, a)).toMatchObject({ state: "work", session: "coders@laptop" });
    await as(s, "coders@laptop", "ticket.set", { ticket: a, in: "40m" });
    const b = await make(s, "coders", "Пока другое");
    expect(await one(s, b)).toMatchObject({ state: "work", session: "coders@laptop" });
    await s.ask("ticket.set", { ticket: a, note: "владелец смотрит" });
    expect(await s.ask("ticket.new", { project: "site", on: "losses", key: "map-7", text: "потеряно ещё 2" })).toMatchObject({ ok: true, result: { id: a } });
    const still = await one(s, a);
    expect(still.state).toBe("wait");
    expect(still.start).toBeDefined();
    expect(gives(s).filter((g) => g.ticket === a)).toHaveLength(1);
    // разбудить сейчас — resume вместе с заметкой: тикет ждёт свою сессию, а не свободную вторую
    expect(await s.ask("ticket.set", { ticket: a, resume: true, note: "владелец ответил: чинить" })).toMatchObject({ ok: true, result: { state: "ready" } });
    const queued = await one(s, a);
    expect(queued.state).toBe("ready");
    expect(queued.start).toBeUndefined();
    expect(gives(s).filter((g) => g.name === "coders-2")).toEqual([]);
    await as(s, "coders@laptop", "ticket.set", { ticket: b, verdict: "done" });
    expect(await one(s, a)).toMatchObject({ state: "work", session: "coders@laptop" });
    expect(String(lastGive(s, a).text)).toContain(
      "Заметки к тикету (3):\n— pult~yuri@example.com: владелец смотрит\n— pult~yuri@example.com: потеряно ещё 2\n— pult~yuri@example.com: владелец ответил: чинить",
    );
  });
});

describe("фабрика: срочный тикет", () => {
  // эталон 35 — чьё: факт — срочный срез ждал 2 часа за старшими (26 нояб.)
  it("35 · срочный — впереди старших: очередь из трёх при занятой сессии, срочный четвёртый уходит первым; тикет в работе не прерван; first: false снимает срочность", async () => {
    const { s } = await applied();
    const current = await make(s, "cto", "Текущее");
    const queue = [await make(s, "cto", "Седьмой"), await make(s, "cto", "Восьмой"), await make(s, "cto", "Девятый")];
    const n = gives(s).length;
    const urgent = await make(s, "cto", "Срочный срез", { first: true });
    expect(await one(s, urgent)).toMatchObject({ state: "ready", first: true });
    expect(await one(s, current)).toMatchObject({ state: "work", session: "cto@laptop" });
    expect(gives(s)).toHaveLength(n);
    await as(s, "cto@laptop", "ticket.set", { ticket: current, verdict: "done" });
    expect(await one(s, urgent)).toMatchObject({ state: "work", session: "cto@laptop" });
    // срочность ставят и снимают правкой
    expect(await s.ask("ticket.set", { ticket: queue[2], first: true })).toMatchObject({ ok: true });
    expect((await one(s, queue[2]!)).first).toBe(true);
    expect(await s.ask("ticket.set", { ticket: queue[2], first: false })).toMatchObject({ ok: true });
    expect((await one(s, queue[2]!)).first).toBeUndefined();
    await as(s, "cto@laptop", "ticket.set", { ticket: urgent, verdict: "done" });
    expect(await one(s, queue[0]!)).toMatchObject({ state: "work", session: "cto@laptop" });
    expect(gives(s).map((g) => g.ticket)).toEqual([current, urgent, queue[0]]);
  });
});

describe("фабрика: проверка поста", () => {
  // эталон 36 — чьё: код — проверка шага командой, перенесена на пост
  it("36 · проверка поста у тикета в работе; не прошла — возврат той же сессии, второй — стоп", async () => {
    const { s } = await applied({ ...DEF, posts: { ...DEF.posts, cto: POST({ check: { run: "sh gate.sh {id}", for: "20m" } }) } });
    const t = await make(s, "cto", "Срезы");
    const queued = await make(s, "cto", "В очереди");
    expect(await one(s, t)).toMatchObject({ state: "work", session: "cto@laptop", check: { run: `sh gate.sh ${t}`, for: "20m" } });
    // проверка — у тикета в работе: тикету в очереди её не называют
    expect((await one(s, queued)).check).toBeUndefined();
    const n = gives(s).length;
    expect(await s.ask("ticket.set", { ticket: t, verdict: "back", note: `проверка «sh gate.sh ${t}» не прошла: код 1\nтест 7 красный` }, "klaptop")).toMatchObject({ ok: true, result: { state: "work" } });
    expect(await one(s, t)).toMatchObject({ state: "work", session: "cto@laptop", returns: 1 });
    expect(gives(s)).toHaveLength(n);
    expect(await s.ask("ticket.set", { ticket: t, verdict: "back", note: "снова красный" }, "klaptop")).toMatchObject({ ok: true, result: { state: "stop" } });
    const stopped = await one(s, t);
    expect(stopped).toMatchObject({ state: "stop", why: "второй возврат", returns: 2 });
    expect(stopped.check).toBeUndefined();
  });
});

describe("фабрика: определение и сессии постов", () => {
  // эталон 37 — чьё: факт — 26 нояб. 24 тикета убранных сессий передавали руками
  it("37 · определение убирает лишние сессии: size 3 → 2 — тикет третьей сессии в очереди поста, ей session.stop, позывной в closed", async () => {
    const { s, file } = await applied({ ...DEF, posts: { ...DEF.posts, coders: POST({ size: 3 }) } });
    const ids = [await make(s, "coders", "Первый"), await make(s, "coders", "Второй"), await make(s, "coders", "Третий")];
    expect(await one(s, ids[2]!)).toMatchObject({ state: "work", session: "coders-3@laptop" });
    const row = (callsign: string): SessionRow => ({ callsign, state: "idle", spec: { name: callsign.split("@")[0]!, cwd: "~/work/post", project: "site" }, by: "~yuri@example.com", since: 1 });
    s.state.sessions = ["cto@laptop", "coders@laptop", "coders-2@laptop", "coders-3@laptop"].map(row);
    file.text = JSON.stringify({ ...DEF, posts: { ...DEF.posts, coders: POST({ size: 2 }) } });
    file.sha = "c2";
    const r = await s.ask("factory.apply", { project: "site", repo: "team/roles" });
    expect(r).toMatchObject({ ok: true, result: { commit: "c2", closed: ["coders-3@laptop"], opened: [], failed: [] } });
    expect(sent(s, "session.stop").map((f) => f.to)).toEqual(["coders-3@laptop"]);
    const back = await one(s, ids[2]!);
    expect(back).toMatchObject({ state: "ready", to: "coders" });
    expect(back.session).toBeUndefined();
    // освободилась сессия поста — тикет у неё
    await as(s, "coders@laptop", "ticket.set", { ticket: ids[0], verdict: "done" });
    expect(await one(s, ids[2]!)).toMatchObject({ state: "work", session: "coders@laptop" });
  });
});

describe("фабрика: список и числа очереди", () => {
  // эталон 38 — чьё: факт — один вызов списка вернул 893 061 знак
  it("38 · список — строки без текста: 60 тикетов по 2 000 знаков — 60 строк без text и notes, ответ короче 15 000 знаков; по номеру — text и notes на месте", async () => {
    const { s } = await applied();
    const text = "я".repeat(2000);
    const ids: string[] = [];
    for (let i = 1; i <= 60; i++) ids.push(((await s.ask("ticket.new", { project: "site", title: `Дело ${i}`, text })).result as { id: string }).id);
    await s.ask("ticket.set", { ticket: ids[0], note: "заметка к первому" });
    const r = await s.ask("ticket.list", { project: "site", state: "ready" });
    const rows = (r.result as { tickets: Ticket[] }).tickets;
    expect(rows).toHaveLength(60);
    for (const t of rows) {
      expect(t.text).toBeUndefined();
      expect(t.notes).toBeUndefined();
      expect(t.files).toBeUndefined();
    }
    expect(JSON.stringify(r.result).length).toBeLessThan(15_000);
    const full = await one(s, ids[0]!);
    expect(full.text).toBe(text);
    expect(full.notes!.map((n) => n.text)).toEqual(["заметка к первому"]);
  });

  // эталон 39 — чьё: код
  it("39 · числа очереди: factory.get называет у поста work, ready, first и oldest; спящий в ready не входит", async () => {
    const { s } = await applied();
    const t0 = Date.now();
    await make(s, "cto", "Текущее");
    await make(s, "cto", "В очереди");
    await make(s, "cto", "Срочное", { first: true });
    await make(s, "cto", "Спит", { in: "2h" });
    const got = await load(s);
    expect(got.cto).toMatchObject({ work: 1, ready: 2, first: 1 });
    expect(got.cto!.oldest).toBeGreaterThanOrEqual(0);
    expect(got.cto!.oldest).toBeLessThanOrEqual(Date.now() - t0);
    expect(got.coders).toEqual({ work: 0, ready: 0, first: 0 });
  });
});

describe("фабрика: круг ожидания", () => {
  // эталон 40 — чьё: код
  it("40 · круг и чужое: ждать себя и круг A ждёт B, B ждёт A — bad_input; тикета нет — no_ticket", async () => {
    const { s } = await applied();
    const a = await make(s, "cto", "A");
    const b = await make(s, "coders", "B");
    expect(await as(s, "cto@laptop", "ticket.set", { ticket: a, after: [a] })).toMatchObject({ ok: false, error: "bad_input" });
    expect(await as(s, "coders@laptop", "ticket.set", { ticket: b, after: [a] })).toMatchObject({ ok: true, result: { state: "wait" } });
    expect(await as(s, "cto@laptop", "ticket.set", { ticket: a, after: [b] })).toMatchObject({ ok: false, error: "bad_input" });
    expect(await as(s, "cto@laptop", "ticket.set", { ticket: a, after: ["site-99"] })).toMatchObject({ ok: false, error: "no_ticket" });
    expect(await s.ask("ticket.new", { project: "site", to: "cto", title: "Ждёт ничего", after: ["site-99"] })).toMatchObject({ ok: false, error: "no_ticket" });
    expect(await one(s, a)).toMatchObject({ state: "work", session: "cto@laptop" });
    expect(await one(s, b)).toMatchObject({ state: "wait", after: [a] });
  });
});
