// Эталоны «Фабрики»: очередь поста из нескольких сессий, возврат той же сессии, пост вне потолка; сессия откладывает и передаёт свой тикет;
// заметки доходят до сессии разом при выдаче и отказом перед «сдал»; итог тикета ложится заметкой заведшему.
import { describe, expect, it } from "vitest";
import type { FactoryState, Ticket } from "@sb/protocol";
import type { Outside } from "../env.ts";
import { appliedFleet } from "../../test/factory.ts";
import type { Stand } from "../../test/stand.ts";
import { fire } from "./clock/clock.ts";

const POST = (extra: Record<string, unknown> = {}) => ({ at: "@laptop", cwd: "~/work/post", key: "claude", model: "claude-opus-5-5", for: "1d", ...extra });
/** Определение проекта «site»: пост coders из двух сессий (coders@laptop и coders-2@laptop) и пост cto из одной. */
const DEF = { project: "site", posts: { coders: POST({ size: 2, cwd: "~/work/coders" }), cto: POST() } };
/** Конвейер из одних постов: без потолка, машин и папки. */
const SLICE = { steps: [{ name: "код", post: "coders" }, { name: "приёмка", post: "cto" }] };
/** Конвейер свежих сессий с потолком один. */
const FRESH = { limit: 1, for: "2h", at: ["@laptop"], cwd: "~/work/{id}", key: "claude", model: "claude-sonnet-5-5", steps: [{ name: "сделать", session: "new" }] };

const CH = { CH_URL: "https://ch.test:8443/" };
const applied = (def: unknown = DEF) => appliedFleet(def, CH);
const sent = (s: Stand, type: string) => s.seen.delivered.filter((f) => f.type === type);
const gives = (s: Stand) => sent(s, "work.give");
const one = async (s: Stand, id: string) => ((await s.ask("ticket.list", { ticket: id })).result as { tickets: Ticket[] }).tickets[0]!;
const outside = (s: Stand): Outside => ({ platform: s.platform, fetch: s.deps.fetch!, log: { info() {}, warn() {}, error() {}, with() { return this; } } as never });
/** Запрос от имени сессии машины laptop. */
const as = (s: Stand, callsign: string, type: string, fields: Record<string, unknown>) => s.ask(type, fields, "klaptop", callsign);
const make = async (s: Stand, to: string, title: string, extra: Record<string, unknown> = {}) => ((await s.ask("ticket.new", { project: "site", to, title, ...extra })).result as { id: string }).id;
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

describe("фабрика: очередь поста", () => {
  // эталон 19 — чьё: запрос PoE2, взят в дизайн словом пользователя 21 нояб. («делай»): «свободная сессия берёт следующее сама»
  it("19 · свободная сессия берёт старший тикет: два тикета — двум сессиям поста, третий ждёт и уходит той, что сдала первой; имя второй сессии занято — определение не применяется", async () => {
    const { s, file } = await applied();
    const a = await make(s, "coders", "Первый");
    const b = await make(s, "coders", "Второй");
    const c = await make(s, "coders", "Третий");
    expect(await one(s, a)).toMatchObject({ state: "work", session: "coders@laptop" });
    expect(await one(s, b)).toMatchObject({ state: "work", session: "coders-2@laptop" });
    expect(await one(s, c)).toMatchObject({ state: "ready" });
    // вторая сессия получает документ поста со своим именем: машина откроет её, если сессии нет
    expect(lastGive(s, b)).toMatchObject({ to: "@laptop", name: "coders-2", spec: { name: "coders-2", cwd: "~/work/coders", project: "site", key: "claude", model: "claude-opus-5-5" } });
    expect(gives(s).map((g) => g.ticket)).toEqual([a, b]);
    // первой сдала вторая сессия — третий тикет у неё
    expect(await as(s, "coders-2@laptop", "ticket.set", { ticket: b, verdict: "done" })).toMatchObject({ ok: true, result: { state: "done" } });
    expect(await one(s, c)).toMatchObject({ state: "work", session: "coders-2@laptop" });
    expect(lastGive(s, c)).toMatchObject({ name: "coders-2" });
    // имя второй сессии поста занято другим постом — определение не применяется, действует прежнее
    file.text = JSON.stringify({ ...DEF, posts: { ...DEF.posts, "coders-2": POST() } });
    file.sha = "c2";
    const r = await s.ask("factory.apply", { project: "site", repo: "team/roles" });
    expect(r).toMatchObject({ ok: false, error: "bad_factory" });
    expect(r.why).toContain("posts.coders.size");
  });

  // эталон 20 — чьё: код — возврат ведёт та сессия, что вела шаг
  it("20 · возврат идёт той же сессии: пока она занята, тикет ждёт её, а не свободную вторую сессию поста", async () => {
    const { s } = await applied({ ...DEF, lines: { slice: SLICE } });
    const t = await make(s, "slice", "Срез");
    expect(await one(s, t)).toMatchObject({ state: "work", step: 0, session: "coders@laptop" });
    expect(await as(s, "coders@laptop", "ticket.set", { ticket: t, verdict: "done", note: "срез готов" })).toMatchObject({ ok: true, result: { state: "ready", step: 1 } });
    expect(await one(s, t)).toMatchObject({ state: "work", step: 1, session: "cto@laptop" });
    // та же сессия занята другим тикетом
    const other = await make(s, "coders", "Другое");
    expect(await one(s, other)).toMatchObject({ state: "work", session: "coders@laptop" });
    const n = gives(s).length;
    expect(await as(s, "cto@laptop", "ticket.set", { ticket: t, verdict: "back", note: "нет эталона" })).toMatchObject({ ok: true, result: { state: "ready", step: 0 } });
    // вторая сессия поста свободна, но возврат ей не отдан
    const waiting = await one(s, t);
    expect(waiting.state).toBe("ready");
    expect(waiting.session).toBeUndefined();
    expect(gives(s)).toHaveLength(n);
    expect(gives(s).filter((g) => g.name === "coders-2")).toEqual([]);
    // та же сессия освободилась — возврат у неё
    await as(s, "coders@laptop", "ticket.set", { ticket: other, verdict: "done" });
    expect(await one(s, t)).toMatchObject({ state: "work", step: 0, session: "coders@laptop", returns: 1 });
    expect(lastGive(s, t)).toMatchObject({ name: "coders", step: "код" });
    expect(String(lastGive(s, t).text)).toContain("Вернули с замечанием: нет эталона");
  });

  // эталон 21 — чьё: факт — определение проекта применяли 41 раз за 27 часов, потолок правили руками (история флота 20–21 нояб.)
  it("21 · пост не занимает потолок: свежий шаг занял потолок проекта — тикет конвейера из постов всё равно в работе; загрузка считает только свежий шаг", async () => {
    const { s, file, result } = await applied({ ...DEF, limit: 1, lines: { fresh: FRESH, slice: SLICE } });
    // конвейер из одних постов без limit, at и cwd применяется
    expect(result).toMatchObject({ lines: 2 });
    const f = await make(s, "fresh", "Свежий шаг");
    expect(await one(s, f)).toMatchObject({ state: "work" });
    const t = await make(s, "slice", "Срез постом");
    expect(await one(s, t)).toMatchObject({ state: "work", session: "coders@laptop" });
    // потолок держится для свежих шагов
    const g = await make(s, "fresh", "Второй свежий");
    expect(await one(s, g)).toMatchObject({ state: "ready" });
    expect(await load(s)).toMatchObject({ work: 1, lines: { fresh: { work: 1 }, slice: { work: 0 } } });
    // конвейер со свежей сессией без потолка — не применяется
    const { limit: _, ...unlimited } = FRESH;
    file.text = JSON.stringify({ ...DEF, limit: 1, lines: { fresh: unlimited, slice: SLICE } });
    file.sha = "c2";
    const r = await s.ask("factory.apply", { project: "site", repo: "team/roles" });
    expect(r).toMatchObject({ ok: false, error: "bad_factory" });
    expect(r.why).toContain("lines.fresh:");
  });
});

describe("фабрика: сессия откладывает и передаёт свой тикет", () => {
  // эталон 22 — чьё: факт — 0 из 25 тикетов «разбуди меня» дошли до сессии, пока она вела шаг (история флота 20–21 нояб.)
  it("22 · отложила свой тикет — взяла следующий: место свободно сразу; чужой шаг отложить нельзя", async () => {
    const { s } = await applied();
    const a = await make(s, "cto", "Ждёт сборки");
    const b = await make(s, "cto", "Следующий");
    expect(await one(s, b)).toMatchObject({ state: "ready" });
    expect(await as(s, "cto@laptop", "ticket.set", { ticket: a, in: "40m", note: "жду сборку 812" })).toMatchObject({ ok: true, result: { state: "ready" } });
    const later = await one(s, a);
    expect(later.state).toBe("ready");
    expect(later.session).toBeUndefined();
    expect(later.start! - Date.now()).toBeGreaterThan(39.5 * 60_000);
    expect(later.start! - Date.now()).toBeLessThanOrEqual(40 * 60_000);
    expect(await one(s, b)).toMatchObject({ state: "work", session: "cto@laptop" });
    expect(lastGive(s, b)).toMatchObject({ name: "cto" });
    // чужой шаг: другая сессия и человек — not_yours; тикет не в работе — bad_state
    expect(await as(s, "coders@laptop", "ticket.set", { ticket: b, in: "40m" })).toMatchObject({ ok: false, error: "not_yours" });
    expect(await s.ask("ticket.set", { ticket: b, in: "40m" })).toMatchObject({ ok: false, error: "not_yours" });
    expect(await as(s, "cto@laptop", "ticket.set", { ticket: a, in: "40m" })).toMatchObject({ ok: false, error: "bad_state" });
    expect(await one(s, b)).toMatchObject({ state: "work", session: "cto@laptop" });
  });

  // эталон 23 — чьё: запрос PoE2 — «по событию дело возвращается той же сессии»
  it("23 · заметка снимает отсрочку: тикет ждёт свою сессию, а не свободную вторую; сдав текущий, она получает его с обеими заметками", async () => {
    const { s } = await applied();
    const a = await make(s, "coders", "Ждёт ответа владельца");
    await as(s, "coders@laptop", "ticket.set", { ticket: a, in: "40m", note: "жду ответ владельца" });
    const b = await make(s, "coders", "Пока другое");
    expect(await one(s, b)).toMatchObject({ state: "work", session: "coders@laptop" });
    expect((await one(s, a)).start).toBeDefined();
    // человек пишет заметку в отложенный тикет — отсрочка снята
    await s.ask("ticket.set", { ticket: a, note: "владелец ответил: да" });
    const woke = await one(s, a);
    expect(woke.start).toBeUndefined();
    expect(woke.state).toBe("ready");
    expect(gives(s).filter((g) => g.name === "coders-2")).toEqual([]);
    // своя сессия сдала текущий — отложенный у неё, с обеими заметками
    await as(s, "coders@laptop", "ticket.set", { ticket: b, verdict: "done" });
    expect(await one(s, a)).toMatchObject({ state: "work", session: "coders@laptop" });
    expect(String(lastGive(s, a).text)).toContain("Заметки к тикету (2):\n— coders@laptop: жду ответ владельца\n— pult~yuri@example.com: владелец ответил: да");
    expect(ticketLines(s).filter((l) => l.kind === "wake")).toMatchObject([{ ticket: a }]);
  });

  // эталон 24 — чьё: запрос PoE2 — «жду события или срока»
  it("24 · срок возвращает тикет той же сессии: до срока ждёт, в срок — у неё, не у свободной второй; «стопа» нет", async () => {
    const { s } = await applied();
    const a = await make(s, "coders", "Проверить выкладку");
    await as(s, "coders@laptop", "ticket.set", { ticket: a, in: "40m", note: "жду выкладку" });
    const start = (await one(s, a)).start!;
    expect(await tick(s, start - 1)).toBe(0);
    expect(await one(s, a)).toMatchObject({ state: "ready" });
    expect(await tick(s, start)).toBe(1);
    expect(await one(s, a)).toMatchObject({ state: "work", session: "coders@laptop" });
    expect(lastGive(s, a)).toMatchObject({ name: "coders" });
    expect(gives(s).filter((g) => g.name === "coders-2")).toEqual([]);
    expect(ticketLines(s).map((l) => l.kind)).toContain("defer");
    expect(ticketLines(s).filter((l) => l.kind === "stop")).toEqual([]);
  });

  // эталон 28 — чьё: запрос PoE2 — «передать дело дальше, не закрывая; история общая»
  it("28 · передал — тикет тот же: у нового исполнителя с прежними заметками, сессия свободна и берёт следующий; передать чужой шаг нельзя", async () => {
    const { s } = await applied();
    const a = await make(s, "coders", "Вопрос архитектуры");
    const b = await make(s, "coders", "Второе");
    const c = await make(s, "coders", "Третье");
    expect(await one(s, b)).toMatchObject({ session: "coders-2@laptop" });
    await s.ask("ticket.set", { ticket: a, note: "смотри дизайн очереди" });
    // человек и чужая сессия шаг в работе не передают
    expect(await s.ask("ticket.set", { ticket: a, to: "cto" })).toMatchObject({ ok: false, error: "bad_state" });
    expect(await as(s, "coders-2@laptop", "ticket.set", { ticket: a, to: "cto" })).toMatchObject({ ok: false, error: "bad_state" });
    expect(await as(s, "coders@laptop", "ticket.set", { ticket: a, to: "cto", note: "это к CTO: граница модулей" })).toMatchObject({ ok: true });
    const moved = await one(s, a);
    expect(moved).toMatchObject({ id: a, to: "cto", step: 0, state: "work", session: "cto@laptop" });
    expect(moved.notes!.map((n) => [n.by, n.text])).toEqual([["pult~yuri@example.com", "смотри дизайн очереди"], ["coders@laptop", "это к CTO: граница модулей"]]);
    expect(lastGive(s, a)).toMatchObject({ name: "cto" });
    expect(await one(s, c)).toMatchObject({ state: "work", session: "coders@laptop" });
    expect(ticketLines(s).filter((l) => l.kind === "assign")).toMatchObject([{ ticket: a, from: "work", to: "cto" }]);
  });
});

describe("фабрика: заметки и итог доходят до сессии", () => {
  // эталон 25 — чьё: запрос PoE2 — «итог чужой работы» приходит событием, а не опросом
  it("25 · итог идёт заведшему: тикет, заведённый сессией со своего шага, помнит его; сдан или встал — заметка в тикет заведшего, отсрочка снята", async () => {
    const { s } = await applied();
    const a = await make(s, "coders", "Большая задача");
    expect(await one(s, a)).toMatchObject({ session: "coders@laptop" });
    const b = ((await as(s, "coders@laptop", "ticket.new", { project: "site", to: "cto", title: "Решение по границе" })).result as { id: string }).id;
    expect((await one(s, b)).parent).toBe(a);
    // тикет, заведённый человеком, заведшего шага не помнит
    expect((await one(s, a)).parent).toBeUndefined();
    await as(s, "coders@laptop", "ticket.set", { ticket: a, in: "2h", note: "жду решение CTO" });
    expect((await one(s, a)).start).toBeDefined();
    await as(s, "cto@laptop", "ticket.set", { ticket: b, verdict: "done", note: "граница по контракту" });
    const back = await one(s, a);
    expect(back).toMatchObject({ state: "work", session: "coders@laptop" });
    expect(back.start).toBeUndefined();
    expect(back.notes!.at(-1)).toMatchObject({ by: ".factory", text: `${b} сдан: граница по контракту` });
    expect(back.notes!.at(-1)!.verdict).toBeUndefined();
    // потомок встал — заведшему причина
    const c = ((await as(s, "coders@laptop", "ticket.new", { project: "site", to: "cto", title: "Доступ к репо" })).result as { id: string }).id;
    expect(await as(s, "cto@laptop", "ticket.set", { ticket: c, verdict: "stop", note: "нужен доступ владельца" })).toMatchObject({ ok: true, result: { state: "stop" } });
    expect((await one(s, a)).notes!.at(-1)).toMatchObject({ by: ".factory", text: `${c} встал: нужен доступ владельца` });
  });

  // эталон 26 — чьё: факт — 121 из 218 заметок к тикету в работе не дошли до сессии, которая его вела (история флота 20–21 нояб.)
  it("26 · «сдал» не закрывает непрочитанное: один отказ unread с текстом заметки; своя заметка и «сдал» человека не держат", async () => {
    const { s } = await applied();
    const t = await make(s, "cto", "Ретро");
    await s.ask("ticket.set", { ticket: t, note: "добавь вопрос про сроки" });
    const unread = await as(s, "cto@laptop", "ticket.set", { ticket: t, verdict: "done", note: "ретро готово" });
    expect(unread).toMatchObject({ ok: false, error: "unread" });
    expect(String(unread.why)).toContain("добавь вопрос про сроки");
    expect(await one(s, t)).toMatchObject({ state: "work", session: "cto@laptop" });
    expect(await as(s, "cto@laptop", "ticket.set", { ticket: t, verdict: "done", note: "ретро готово, сроки учтены" })).toMatchObject({ ok: true, result: { state: "done" } });
    // своя заметка сессии отказа не даёт
    const u = await make(s, "cto", "Своё");
    await as(s, "cto@laptop", "ticket.set", { ticket: u, note: "сначала прочту журнал" });
    expect(await as(s, "cto@laptop", "ticket.set", { ticket: u, verdict: "done" })).toMatchObject({ ok: true, result: { state: "done" } });
    // «сдал» человека заметки не держат
    const v = await make(s, "cto", "Человек сдаёт");
    await as(s, "coders@laptop", "ticket.set", { ticket: v, note: "заметка соседа" });
    expect(await s.ask("ticket.set", { ticket: v, verdict: "done" })).toMatchObject({ ok: true, result: { state: "done" } });
    expect(ticketLines(s).filter((l) => l.kind === "unread")).toMatchObject([{ ticket: t, notes: 1 }]);
  });

  // эталон 27 — чьё: запрос PoE2 — «пачка отдаётся одной сводкой, когда сессия свободна»
  it("27 · заметки приходят разом: три заметки к тикету в очереди — одной сводкой при выдаче; при следующей выдаче шага — только пришедшие после", async () => {
    const { s } = await applied();
    const a = await make(s, "cto", "Текущее");
    const b = await make(s, "cto", "В очереди");
    await s.ask("ticket.set", { ticket: b, note: "первая от человека" });
    await as(s, "coders@laptop", "ticket.set", { ticket: b, note: "от соседней сессии" });
    await s.ask("ticket.set", { ticket: b, note: "вторая от человека" });
    expect(gives(s).filter((g) => g.ticket === b)).toEqual([]);
    await as(s, "cto@laptop", "ticket.set", { ticket: a, verdict: "done" });
    const first = String(lastGive(s, b).text);
    expect(first).toContain("Заметки к тикету (3):\n— pult~yuri@example.com: первая от человека\n— coders@laptop: от соседней сессии\n— pult~yuri@example.com: вторая от человека");
    // сессия отложила шаг, он вернулся по сроку: прежних трёх в тексте нет — только пришедшее после первой выдачи
    await as(s, "cto@laptop", "ticket.set", { ticket: b, in: "40m", note: "жду ответа владельца" });
    expect(await tick(s, (await one(s, b)).start!)).toBe(1);
    expect(gives(s).filter((g) => g.ticket === b)).toHaveLength(2);
    const second = String(lastGive(s, b).text);
    for (const old of ["первая от человека", "от соседней сессии", "вторая от человека"]) expect(second).not.toContain(old);
    expect(second).toContain("Заметки к тикету (1):\n— cto@laptop: жду ответа владельца");
  });
});
