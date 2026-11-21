// Эталоны «Фабрики», шаг 2: тикет сессии — создан, отдан её машине, сдан вердиктом; кто может дать вердикт; очередь, возврат, срок.
import { describe, expect, it } from "vitest";
import { fail, type Frame, ok, type SessionRow, type Ticket } from "@sb/protocol";
import type { Outside } from "../env.ts";
import { type Stand, stand } from "../../test/stand.ts";
import { fire, list } from "./clock/clock.ts";

const session = (callsign: string, project = "site"): SessionRow => ({ callsign, state: "idle", spec: { name: callsign.split("@")[0]!, cwd: "~", project }, by: "~yuri@example.com", since: 1 });

/** Флот с проектом «site»: Юра и Аня — участники, Олег — нет; три сессии проекта на laptop и server. */
function fleet(): Stand {
  const s = stand();
  s.state.sessions = [session("coder@laptop"), session("review@laptop"), session("ops@server")];
  s.state.fleetAnswer = (f) =>
    f.type === "people.list"
      ? ok(f.id!, { people: [], projects: [{ id: "site", name: "Сайт", members: ["~yuri@example.com", "~anya@example.com"] }] })
      : ok(f.id!, { called: f.type });
  return s;
}
const gives = (s: Stand) => s.seen.delivered.filter((f) => f.type === "work.give");
const one = async (s: Stand, id: string, as = "kyura1") => ((await s.ask("ticket.list", { ticket: id }, as)).result as { tickets: Ticket[] }).tickets[0]!;
const terms = (s: Stand) => list(s.env, s.fleet, "factory/");
const outside = (s: Stand): Outside => ({ platform: s.platform, fetch: s.deps.fetch!, log: { info() {}, warn() {}, error() {}, with() { return this; } } as never });
/** Запрос от имени сессии: пропуск её машины и позывной. */
const as = (s: Stand, callsign: string, type: string, fields: Record<string, unknown>) => s.ask(type, fields, callsign.endsWith("@laptop") ? "klaptop" : "kyura1", callsign.endsWith("@laptop") ? callsign : undefined);

describe("фабрика: тикет сессии", () => {
  it("создан → «дать работу» ушло машине исполнителя → в работе со сроком на часах; вердикт ведущей сессии закрывает тикет и снимает срок", async () => {
    const s = fleet();
    const t0 = Date.now();
    const made = await s.ask("ticket.new", { project: "site", to: "coder@laptop", for: "2h", title: "Обход не останавливается у поля", text: "Готово: эталон остановки зелёный." });
    expect(made).toMatchObject({ ok: true, result: { id: "site-1" } });
    const [g] = gives(s);
    expect(g).toMatchObject({ type: "work.give", from: ".factory", to: "@laptop", name: "coder", ticket: "site-1" });
    expect(String(g!.text)).toContain("Обход не останавливается у поля");
    expect(String(g!.text)).toContain('"ticket":"site-1"');
    const work = await one(s, "site-1");
    expect(work).toMatchObject({ id: "site-1", project: "site", state: "work", session: "coder@laptop", to: "coder@laptop", by: "pult~yuri@example.com", returns: 0 });
    expect(work.until! - t0).toBeGreaterThanOrEqual(2 * 3600_000);
    expect(await terms(s)).toMatchObject([{ id: "factory/site/1", kind: "factory.term", at: work.until }]);
    // сдаёт сессия, которая ведёт шаг
    expect(await as(s, "coder@laptop", "ticket.set", { ticket: "site-1", verdict: "done", note: "эталон зелёный" })).toMatchObject({ ok: true, result: { id: "site-1", state: "done" } });
    const done = await one(s, "site-1");
    expect(done.state).toBe("done");
    expect(done.notes).toMatchObject([{ by: "coder@laptop", verdict: "done", text: "эталон зелёный" }]);
    expect(await terms(s)).toEqual([]);
  });

  // эталон 15 — чьё: слово пользователя («по сути конвейер — серия сессий с приёмкой»): вердикт шагу даёт его исполнитель или человек
  it("15 · вердикт — только исполнителю: «сдал» от сессии, которая шаг не ведёт, — отказ словом; «вернул» от человека принят", async () => {
    const s = fleet();
    await s.ask("ticket.new", { project: "site", to: "coder@laptop", for: "2h", title: "Шапка сайта" });
    expect(await as(s, "review@laptop", "ticket.set", { ticket: "site-1", verdict: "done" })).toMatchObject({ ok: false, error: "not_yours" });
    expect((await one(s, "site-1")).state).toBe("work");
    // человек возвращает шаг с замечанием: тикет снова уходит той же сессии, замечание — в тексте шага
    expect(await s.ask("ticket.set", { ticket: "site-1", verdict: "back", note: "логотип не того размера" }, "kanya1")).toMatchObject({ ok: true });
    expect(gives(s)).toHaveLength(2);
    expect(String(gives(s)[1]!.text)).toContain("Вернули с замечанием: логотип не того размера");
    expect(await one(s, "site-1")).toMatchObject({ state: "work", session: "coder@laptop", returns: 1 });
    // машина исполнителя говорит за шаг своей сессии; чужая — нет
    expect(await s.ask("ticket.set", { ticket: "site-1", verdict: "stop", note: "проверка не прошла" }, "kolegm")).toMatchObject({ ok: false });
  });

  it("у сессии один тикет в работе: второй ждёт вердикта первого, затем уходит сам", async () => {
    const s = fleet();
    await s.ask("ticket.new", { project: "site", to: "coder@laptop", for: "1h", title: "Первый" });
    await s.ask("ticket.new", { project: "site", to: "coder@laptop", for: "1h", title: "Второй" });
    await s.ask("ticket.new", { project: "site", to: "ops@server", for: "1h", title: "Другой исполнитель" });
    expect(gives(s).map((g) => g.ticket)).toEqual(["site-1", "site-3"]);
    expect((await one(s, "site-2")).state).toBe("ready");
    await as(s, "coder@laptop", "ticket.set", { ticket: "site-1", verdict: "done" });
    expect(gives(s).map((g) => g.ticket)).toEqual(["site-1", "site-3", "site-2"]);
    expect((await one(s, "site-2")).state).toBe("work");
    // список: по состоянию и по исполнителю
    const list = async (f: Record<string, unknown>) => ((await s.ask("ticket.list", { project: "site", ...f })).result as { tickets: Ticket[] }).tickets.map((t) => t.id);
    expect(await list({ state: "work" })).toEqual(["site-3", "site-2"]);
    expect(await list({ to: "coder@laptop" })).toEqual(["site-2", "site-1"]);
    expect(await list({ session: "ops@server" })).toEqual(["site-3"]);
  });

  // эталон 4 дизайна проверяется на конвейере (шаг 3); здесь — то же правило у тикета сессии
  it("второй возврат на одном шаге ставит тикет в «стоп»; человек возвращает его в очередь — счёт возвратов с нуля", async () => {
    const s = fleet();
    await s.ask("ticket.new", { project: "site", to: "coder@laptop", for: "1h", title: "Подвал" });
    await s.ask("ticket.set", { ticket: "site-1", verdict: "back", note: "раз" });
    expect(await s.ask("ticket.set", { ticket: "site-1", verdict: "back", note: "два" })).toMatchObject({ ok: true, result: { state: "stop" } });
    expect(await one(s, "site-1")).toMatchObject({ state: "stop", why: "второй возврат", returns: 2 });
    expect(gives(s)).toHaveLength(2);
    expect(await terms(s)).toEqual([]);
    // вердикт вставшему не дают; возвращают в очередь
    expect(await s.ask("ticket.set", { ticket: "site-1", verdict: "done" })).toMatchObject({ ok: false, error: "bad_state" });
    expect(await s.ask("ticket.set", { ticket: "site-1", resume: true, note: "делаем по макету" })).toMatchObject({ ok: true, result: { state: "ready" } });
    expect(await one(s, "site-1")).toMatchObject({ state: "work", returns: 0 });
    expect(gives(s)).toHaveLength(3);
  });

  it("машина отказала в работе — тикет в «стоп» с её словами, повторов нет", async () => {
    const s = fleet();
    s.state.answer = (f: Frame) => (f.type === "work.give" ? fail(f.id!, "failed", "coder@laptop: второй сбой до готовности") : ok(f.id!, {}));
    await s.ask("ticket.new", { project: "site", to: "coder@laptop", for: "1h", title: "Шапка" });
    expect(await one(s, "site-1")).toMatchObject({ state: "stop", why: "работа не дана: failed: coder@laptop: второй сбой до готовности" });
    expect(gives(s)).toHaveLength(1);
    expect(await terms(s)).toEqual([]);
  });

  it("срок шага вышел без вердикта — «стоп» с причиной «срок вышел»; следующий тикет сессии уходит в работу", async () => {
    const s = fleet();
    await s.ask("ticket.new", { project: "site", to: "coder@laptop", for: "20m", title: "Долгий" });
    await s.ask("ticket.new", { project: "site", to: "coder@laptop", for: "20m", title: "Следующий" });
    const t = (await one(s, "site-1")).until!;
    // до срока часы шаг не трогают
    expect(await fire(s.env, s.fleet, outside(s), t - 1000)).toBe(0);
    expect((await one(s, "site-1")).state).toBe("work");
    expect(await fire(s.env, s.fleet, outside(s), t + 1)).toBe(1);
    expect(await one(s, "site-1")).toMatchObject({ state: "stop", why: "срок вышел" });
    expect((await one(s, "site-1")).notes!.at(-1)).toMatchObject({ by: ".factory", verdict: "stop", text: "срок вышел" });
    expect(gives(s).map((g) => g.ticket)).toEqual(["site-1", "site-2"]);
    // вердикт опоздавшей сессии — отказ: шаг уже не в работе
    expect(await as(s, "coder@laptop", "ticket.set", { ticket: "site-1", verdict: "done" })).toMatchObject({ ok: false, error: "bad_state" });
    await s.ask("ticket.set", { ticket: "site-2", drop: true });
    expect(await terms(s)).toEqual([]);
  });

  it("бэклог: тикет без исполнителя ждёт; назначили — ушёл в работу; снятый закрыт без работы", async () => {
    const s = fleet();
    await s.ask("ticket.new", { project: "site", title: "Когда-нибудь" });
    await s.ask("ticket.new", { project: "site", title: "Не нужно" });
    expect(gives(s)).toHaveLength(0);
    expect(await one(s, "site-1")).toMatchObject({ state: "ready" });
    expect((await one(s, "site-1")).to).toBeUndefined();
    // назначить без срока нельзя: числа по умолчанию нет
    expect(await s.ask("ticket.set", { ticket: "site-1", to: "ops@server" })).toMatchObject({ ok: false, error: "no_term" });
    expect(await s.ask("ticket.set", { ticket: "site-1", to: "ops@server", for: "1d" })).toMatchObject({ ok: true });
    expect(gives(s)).toMatchObject([{ to: "@server", name: "ops", ticket: "site-1" }]);
    expect(await s.ask("ticket.set", { ticket: "site-2", drop: true })).toMatchObject({ ok: true, result: { state: "done" } });
    expect(await one(s, "site-2")).toMatchObject({ state: "done", dropped: true });
    await s.ask("ticket.set", { ticket: "site-1", drop: true });
  });

  // чьё: дизайн «Фабрика», принят словом пользователя 19 нояб. («делай»): вопрос сессии шага идёт создателю тикета — как вопрос дочери идёт родителю
  it("кто дал задачу тикетом: создатель — человек или сессия — назван машине вместе с шагом; сессия самой себе — нет", async () => {
    const s = fleet();
    await s.ask("ticket.new", { project: "site", to: "coder@laptop", for: "2h", title: "От человека" });
    await as(s, "review@laptop", "ticket.new", { to: "ops@server", for: "2h", title: "От сессии" });
    await as(s, "review@laptop", "ticket.new", { to: "review@laptop", for: "1h", title: "Самой себе" });
    expect(gives(s).map((g) => [g.name, g.asker])).toEqual([["coder", "pult~yuri@example.com"], ["ops", "review@laptop"], ["review", undefined]]);
    for (const id of ["site-1", "site-2", "site-3"]) await s.ask("ticket.set", { ticket: id, drop: true });
  });

  // чьё: гейт архитектора (слово пользователя 31 окт.) — одно правило не считается и службой, и страницей: что можно сделать с тикетом, называет служба
  it("что можно сделать с тикетом, называет служба — тем же правилом, каким отказывает запись: по состоянию тикета и по тому, кто спросил", async () => {
    const s = fleet();
    await s.ask("ticket.new", { project: "site", title: "В бэклог" });
    await s.ask("ticket.new", { project: "site", to: "coder@laptop", for: "2h", title: "В работу" });
    const acts = async (id: string, who = "kyura1", sayAs?: string) => ((await s.ask("ticket.list", { ticket: id }, who, sayAs)).result as { tickets: Ticket[] }).tickets[0]!.acts;
    // бэклог: вердикта нет — шаг никто не ведёт; человек назначает или снимает
    expect(await acts("site-1")).toEqual(["drop", "assign"]);
    // в работе: человек даёт вердикт любому шагу; сессия — только своему; исполнителя у идущего шага меняет только сессия, которая его ведёт
    expect(await acts("site-2")).toEqual(["verdict", "drop"]);
    expect(await acts("site-2", "klaptop", "coder@laptop")).toEqual(["verdict", "drop", "assign"]);
    expect(await acts("site-2", "klaptop", "review@laptop")).toEqual(["drop"]);
    expect(await as(s, "review@laptop", "ticket.set", { ticket: "site-2", verdict: "done" })).toMatchObject({ ok: false, error: "not_yours" });
    // встал: вернуть в очередь, снять или назначить другому
    await as(s, "coder@laptop", "ticket.set", { ticket: "site-2", verdict: "stop", note: "нужен человек" });
    expect(await acts("site-2")).toEqual(["resume", "drop", "assign"]);
    // закрыт: ничего; запись отказывает тем же словом
    await s.ask("ticket.set", { ticket: "site-2", drop: true });
    expect(await acts("site-2")).toEqual([]);
    expect(await s.ask("ticket.set", { ticket: "site-2", to: "ops@server", for: "1d" })).toMatchObject({ ok: false, error: "bad_state" });
    expect(await s.ask("ticket.set", { ticket: "site-2", resume: true })).toMatchObject({ ok: false, error: "bad_state" });
    // список тикетов действий не несёт: их спрашивают у тикета по номеру
    expect(((await s.ask("ticket.list", { project: "site" })).result as { tickets: Ticket[] }).tickets.every((t) => t.acts === undefined)).toBe(true);
    await s.ask("ticket.set", { ticket: "site-1", drop: true });
  });

  it("проект и права: сессия создаёт тикет в своём проекте; не участник — отказ; нет проекта, сессии или срока — отказ словом", async () => {
    const s = fleet();
    // сессия проект не называет: берётся её проект
    expect(await as(s, "review@laptop", "ticket.new", { title: "Долг ревью: тест на пустой список" })).toMatchObject({ ok: true, result: { id: "site-1" } });
    expect(await one(s, "site-1")).toMatchObject({ by: "review@laptop", state: "ready" });
    expect(await s.ask("ticket.new", { title: "Без проекта" })).toMatchObject({ ok: false, error: "no_project" });
    expect(await s.ask("ticket.new", { project: "nope", title: "Не тот проект" })).toMatchObject({ ok: false, error: "no_project" });
    expect(await s.ask("ticket.new", { project: "site", title: "Чужой" }, "koleg1")).toMatchObject({ ok: false, error: "forbidden" });
    expect(await s.ask("ticket.list", { ticket: "site-1" }, "koleg1")).toMatchObject({ ok: false, error: "forbidden" });
    expect(await s.ask("ticket.new", { project: "site", to: "ghost@laptop", for: "1h", title: "Никому" })).toMatchObject({ ok: false, error: "no_session" });
    expect(await s.ask("ticket.new", { project: "site", to: "coder@laptop", title: "Без срока" })).toMatchObject({ ok: false, error: "no_term" });
    expect(await s.ask("ticket.set", { ticket: "site-99", verdict: "done" })).toMatchObject({ ok: false, error: "no_ticket" });
    expect(await s.ask("ticket.set", { ticket: "мусор", verdict: "done" })).toMatchObject({ ok: false, error: "no_ticket" });
  });
});
