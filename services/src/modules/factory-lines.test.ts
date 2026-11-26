// Эталоны «Фабрики»: определение проекта из git и посты; тикет посту — выдача, возврат, срок, пауза, одно место на сессию;
// правила входа по времени с проверкой-скриптом и тикет, заведённый спящим.
import { describe, expect, it } from "vitest";
import { fail, type FactoryState, ok, type Ticket } from "@sb/protocol";
import type { Env, Outside } from "../env.ts";
import { appliedFleet, factoryFleet } from "../../test/factory.ts";
import type { Stand } from "../../test/stand.ts";
import { drop, fire, list } from "./clock/clock.ts";

const POST = (at: string, extra: Record<string, unknown> = {}) => ({ at, cwd: "~/work/post", key: "claude", model: "claude-opus-5-5", for: "1d", ...extra });
/** Определение проекта «site»: пост с ролью, пост cto из одной сессии и пост coders из двух. */
const DEF = {
  project: "site", call: ["~yuri@example.com"],
  posts: { "dev-fight": POST("@laptop", { pieces: ["team/roles/designer"] }), cto: POST("@laptop"), coders: POST("@laptop", { size: 2, cwd: "~/work/coders" }) },
};

const applied = (def: unknown = DEF, env?: Partial<Env>) => appliedFleet(def, env);
const sent = (s: Stand, type: string) => s.seen.delivered.filter((f) => f.type === type);
const gives = (s: Stand) => sent(s, "work.give");
const one = async (s: Stand, id: string) => ((await s.ask("ticket.list", { ticket: id })).result as { tickets: Ticket[] }).tickets[0]!;
const outside = (s: Stand): Outside => ({ platform: s.platform, fetch: s.deps.fetch!, log: { info() {}, warn() {}, error() {}, with() { return this; } } as never });
/** Запрос от имени сессии машины laptop. */
const as = (s: Stand, callsign: string, type: string, fields: Record<string, unknown>) => s.ask(type, fields, "klaptop", callsign);
const make = async (s: Stand, to: string, title: string, extra: Record<string, unknown> = {}) => ((await s.ask("ticket.new", { project: "site", to, title, ...extra })).result as { id: string }).id;
const factoryState = async (s: Stand) => ((await s.ask("factory.get", { project: "site" })).result as { factory: FactoryState }).factory;
/** Снять всё, что осталось в работе, во сне и в очереди: сроки уходят с часов. */
async function close(s: Stand) {
  for (const state of ["work", "wait", "ready"]) for (const t of ((await s.ask("ticket.list", { project: "site", state })).result as { tickets: Ticket[] }).tickets) await s.ask("ticket.set", { ticket: t.id, drop: true });
}

describe("фабрика: определение проекта", () => {
  // эталон 9 — чьё: факт (определение в одном файле git с отказом целиком — приём открытых фабрик; слово пользователя — «определение всей системы в git»)
  it("9 · битое определение не применяется: отказ называет путь к месту в файле, действует прежний коммит", async () => {
    const { s, file, result } = await applied();
    expect(result).toMatchObject({ commit: "c1", posts: 3, rules: 0, closed: [], failed: [] });
    // применение открывает сессии постов, которых ещё нет
    expect(result.opened.sort()).toEqual(["coders-2@laptop", "coders@laptop", "cto@laptop", "dev-fight@laptop"]);
    expect(sent(s, "session.open").map((f) => [f.to, (f.spec as { name: string }).name, (f.spec as { project: string }).project]).sort()).toEqual([
      ["@laptop", "coders", "site"], ["@laptop", "coders-2", "site"], ["@laptop", "cto", "site"], ["@laptop", "dev-fight", "site"],
    ]);
    expect(await factoryState(s)).toMatchObject({ project: "site", repo: "team/roles", commit: "c1", paused: false, load: { cto: { work: 0, ready: 0, first: 0 }, coders: { work: 0, ready: 0, first: 0 } } });
    // новый коммит: роль — из чужого репозитория; машины нет; правило шлёт тикеты посту, которого нет
    const broken = structuredClone(DEF) as any;
    broken.posts["dev-fight"].pieces = ["other/repo/designer"];
    broken.posts.cto.at = "@nowhere";
    broken.on = [{ name: "x", every: "10m", to: "ghost" }];
    file.text = JSON.stringify(broken);
    file.sha = "c2";
    const r = await s.ask("factory.apply", { project: "site", repo: "team/roles" });
    expect(r).toMatchObject({ ok: false, error: "bad_factory" });
    for (const part of ["posts.dev-fight.pieces: роли other/repo/designer нет", "posts.cto.at: машины nowhere нет", "on[0].to: поста ghost нет в posts"]) expect(r.why).toContain(part);
    expect((await factoryState(s)).commit).toBe("c1");
    // не JSON, чужой проект, файл с неизвестным ключом, репозиторий не из списка флота, файла нет
    for (const [text, part] of [["{", "не JSON"], [JSON.stringify({ ...DEF, project: "other" }), "project: в файле other"], [JSON.stringify({ ...DEF, extra: 1 }), "extra"]] as const) {
      file.text = text;
      const bad = await s.ask("factory.apply", { project: "site", repo: "team/roles" });
      expect(bad).toMatchObject({ ok: false, error: "bad_factory" });
      expect(bad.why).toContain(part);
    }
    expect(await s.ask("factory.apply", { project: "site", repo: "team/other" })).toMatchObject({ ok: false, error: "bad_factory" });
    file.text = "";
    expect(await s.ask("factory.apply", { project: "site", repo: "team/roles" })).toMatchObject({ ok: false, error: "no_file" });
    expect((await factoryState(s)).commit).toBe("c1");
    // человеку без проекта — его проекты с определением; не участнику — отказ
    expect((await s.ask("factory.get", {})).result).toMatchObject({ projects: [{ project: "site", repo: "team/roles", commit: "c1", paused: false }] });
    expect(await s.ask("factory.get", { project: "site" }, "koleg1")).toMatchObject({ ok: false, error: "forbidden" });
  });
});

describe("фабрика: где лежит определение", () => {
  // чьё: факт (у флота один репозиторий ролей на несколько проектов — определение проекта лежит в папке его кусочка)
  it("определение читается из папки кусочка: один репозиторий ролей держит определения нескольких проектов", async () => {
    const s = await factoryFleet({ text: JSON.stringify(DEF), sha: "c1", dir: "site-roles" });
    // в корне файла нет — корень не подменяет папку
    expect(await s.ask("factory.apply", { project: "site", repo: "team/roles" })).toMatchObject({ ok: false, error: "no_file" });
    expect(await s.ask("factory.apply", { project: "site", repo: "team/roles/site-roles" })).toMatchObject({ ok: true, result: { commit: "c1", posts: 3 } });
    expect(await factoryState(s)).toMatchObject({ repo: "team/roles/site-roles", commit: "c1" });
    // кусочек чужого репозитория и выход из папки — отказ, действует прежнее
    for (const repo of ["team/other/site-roles", "team/roles/../x"]) expect(await s.ask("factory.apply", { project: "site", repo })).toMatchObject({ ok: false, error: "bad_factory" });
    expect((await factoryState(s)).commit).toBe("c1");
    await close(s);
  });
});

describe("фабрика: тикет посту", () => {
  // эталон 4 — чьё: факт (устав Феникса «вторая правка одного места уходит в дизайн»; у Stripe два круга исправления)
  it("4 · второй возврат — «стоп»: человек вернул тикет дважды, сессия больше не получает его; возврат ведёт та же сессия", async () => {
    const { s } = await applied();
    const id = await make(s, "coders", "Навигация по узким мостам");
    expect(await one(s, id)).toMatchObject({ state: "work", session: "coders@laptop" });
    expect(await s.ask("ticket.set", { ticket: id, verdict: "back", note: "срез 2 дублирует службу знания" })).toMatchObject({ ok: true, result: { state: "ready" } });
    expect(await one(s, id)).toMatchObject({ state: "work", session: "coders@laptop", returns: 1 });
    expect(gives(s).at(-1)).toMatchObject({ ticket: id, name: "coders" });
    expect(String(gives(s).at(-1)!.text)).toContain("Вернули с замечанием: срез 2 дублирует службу знания");
    const n = gives(s).length;
    expect(await s.ask("ticket.set", { ticket: id, verdict: "back", note: "снова дубль" })).toMatchObject({ ok: true, result: { state: "stop" } });
    expect(await one(s, id)).toMatchObject({ state: "stop", why: "второй возврат", returns: 2 });
    expect(gives(s)).toHaveLength(n);
    await close(s);
  });

  // эталон 18 (половина служб) — чьё: слово пользователя («серия сессий с приёмкой»): возврат проверки записывает машина сессии, шаг остаётся у той же сессии
  it("18 · проверка держит «сдал»: возврат от машины сессии оставляет тикет в работе у той же сессии; вторая проверка прошла — «сдал» принят", async () => {
    const { s } = await applied();
    const id = await make(s, "cto", "Подбор камней");
    const n = gives(s).length;
    expect(await s.ask("ticket.set", { ticket: id, verdict: "back", note: "проверка «sh gate.sh» не прошла: код 1\nтест 7 красный" }, "klaptop")).toMatchObject({ ok: true, result: { state: "work" } });
    expect(await one(s, id)).toMatchObject({ state: "work", session: "cto@laptop", returns: 1 });
    expect(gives(s)).toHaveLength(n);
    expect(await as(s, "cto@laptop", "ticket.set", { ticket: id, verdict: "done" })).toMatchObject({ ok: true, result: { state: "done" } });
    await close(s);
  });

  // эталон 1 — чьё: факт (взятие одной условной записью — приём Beads и Paperclip)
  it("1 · место берёт один: у поста одна свободная сессия, два события приходят разом — выдан один тикет, второй в очереди", async () => {
    const { s } = await applied();
    const [a, b] = await Promise.all([make(s, "cto", "Первый"), make(s, "cto", "Второй")]);
    expect(gives(s)).toHaveLength(1);
    expect([(await one(s, a)).state, (await one(s, b)).state].sort()).toEqual(["ready", "work"]);
    await close(s);
  });

  // эталон 13 — чьё: слово владельца PoE2 13 нояб. («на паузу, с которой можно восстановиться»)
  it("13 · пауза: тикеты в работе сдаются, новых выдач нет; пауза снята — очередь идёт", async () => {
    const { s } = await applied();
    const ids: string[] = [];
    for (let i = 1; i <= 5; i++) ids.push(await make(s, "coders", "Задача " + i));
    expect(gives(s).map((g) => g.ticket)).toEqual(ids.slice(0, 2));
    expect(await s.ask("factory.pause", { project: "site", on: true })).toMatchObject({ ok: true, result: { paused: true } });
    expect(await s.ask("ticket.set", { ticket: ids[0], verdict: "done" })).toMatchObject({ ok: true, result: { state: "done" } });
    expect(await s.ask("ticket.set", { ticket: ids[1], verdict: "done" })).toMatchObject({ ok: true, result: { state: "done" } });
    ids.push(await make(s, "coders", "Пришёл на паузе"));
    expect(gives(s)).toHaveLength(2);
    expect(await factoryState(s)).toMatchObject({ paused: true, load: { coders: { work: 0, ready: 4 } } });
    await s.ask("factory.pause", { project: "site", on: false });
    expect(gives(s).map((g) => g.ticket)).toEqual(ids.slice(0, 4));
    await close(s);
  });

  // эталон 17 — чьё: слово пользователя («у всех операций должен быть лимит»)
  it("17 · срок вышел — «стоп»: тикет поста без вердикта встаёт с причиной, сессия берёт следующий, повторов нет", async () => {
    const { s } = await applied();
    const a = await make(s, "cto", "Долгий");
    const b = await make(s, "cto", "Следующий");
    const until = (await one(s, a)).until!;
    expect(until - Date.now()).toBeGreaterThan(0.9 * 86_400_000);
    expect(await fire(s.env, s.fleet, outside(s), until - 1000)).toBe(0);
    expect(await fire(s.env, s.fleet, outside(s), until + 1)).toBe(1);
    expect(await one(s, a)).toMatchObject({ state: "stop", why: "срок вышел" });
    expect(await one(s, b)).toMatchObject({ state: "work", session: "cto@laptop" });
    expect(gives(s).map((g) => g.ticket)).toEqual([a, b]);
    await s.ask("ticket.set", { ticket: b, drop: true });
    expect(await list(s.env, s.fleet, "factory/site/")).toEqual([]);
  });

  it("тикет посту: документ поста идёт машине, пост берёт тикеты по одному; заметка к тикету в очереди доходит с выдачей; исполнителя нет — отказ; бэклог назначают посту", async () => {
    const { s } = await applied();
    const a = await make(s, "cto", "Ретро недели");
    const b = await make(s, "cto", "Вопрос владельца");
    expect(gives(s).map((g) => [g.ticket, g.name, (g.spec as { cwd?: string } | undefined)?.cwd])).toEqual([[a, "cto", "~/work/post"]]);
    expect((await one(s, b)).state).toBe("ready");
    await s.ask("ticket.set", { ticket: b, note: "сначала спроси владельца про сроки" });
    await as(s, "cto@laptop", "ticket.set", { ticket: a, verdict: "done" });
    expect(gives(s).map((g) => g.ticket)).toEqual([a, b]);
    expect(String(gives(s).at(-1)!.text)).toContain("Заметки к тикету (1):\n— pult~yuri@example.com: сначала спроси владельца про сроки");
    expect(await s.ask("ticket.new", { project: "site", to: "nowhere", title: "Некому" })).toMatchObject({ ok: false, error: "no_dest" });
    // бэклог → назначить посту: срок у поста свой
    const c = ((await s.ask("ticket.new", { project: "site", title: "Когда-нибудь" })).result as { id: string }).id;
    expect(await s.ask("ticket.set", { ticket: c, to: "coders" })).toMatchObject({ ok: true, result: { state: "ready" } });
    expect(gives(s).at(-1)).toMatchObject({ ticket: c, name: "coders", spec: { cwd: "~/work/coders" } });
    await close(s);
  });
});

/* ===== Правила входа по времени ===== */

const CH = { CH_URL: "https://ch.test:8443/" };
/** Строки истории «rule», которые записали службы: исход, машина проверки и данные срабатывания. */
const ruleLines = (s: Stand): Record<string, unknown>[] =>
  s.seen.net
    .filter((n) => n.url.startsWith(CH.CH_URL) && String(n.init?.body ?? "").includes('"msg":"rule"'))
    .map((n) => {
      const row = JSON.parse(String(n.init!.body)) as { kind: string; machine: string; data: string };
      return { outcome: row.kind, machine: row.machine, ...(JSON.parse(row.data) as Record<string, unknown>) };
    });
/** Правило «каждые 10 минут» с проверкой-скриптом на машине laptop; находка — тикет посту cto. */
const COUNTERS = { name: "counters", every: "10m", to: "cto", key: "counters", text: "Разбери находку счётчиков.", check: { at: "@laptop", run: "node checks/counters.mjs", for: "60s" } };
const RETRO = { name: "retro", cron: "0 9 * * 1", tz: "Europe/Kyiv", to: "cto", title: "Недельная ретроспектива" };
/** Машина отвечает на запуск проверки: код выхода и вывод; остальное — как у стенда. */
function checks(s: Stand, code: number, out = ""): void {
  s.state.answer = (f) => (f.id ? ok(f.id, f.type === "shell.run" ? { run: "r1", state: code ? "failed" : "done", code, out, started: 1, ms: 840 } : { got: f.type }) : null);
}
/** Сработать по всем срокам часов флота до момента at. */
const tick = (s: Stand, at: number) => fire(s.env, s.fleet, outside(s), at);
const tickets = async (s: Stand) => ((await s.ask("ticket.list", { project: "site" })).result as { tickets: Ticket[] }).tickets;
const dues = async (s: Stand) => (await factoryState(s)).next;
/** Сработать по ближайшему сроку правила. */
async function ring(s: Stand, rule: string): Promise<number> {
  const at = (await dues(s))[rule]!;
  expect(await tick(s, at)).toBe(1);
  return at;
}

describe("фабрика: правила входа", () => {
  // эталон 7 — чьё: факт (пустой тик сессии-сторожа стоил 180 456 входных токенов)
  it("7 · тихая проверка не будит: правило «каждые 10 минут», проверка шесть раз вернула код 0 — тикетов 0, работы сессиям 0, строк истории 6", async () => {
    const { s, result } = await applied({ ...DEF, on: [COUNTERS] }, CH);
    expect(result.rules).toBe(1);
    checks(s, 0);
    const opened = sent(s, "session.open").length;
    expect((await dues(s)).counters! - Date.now()).toBeGreaterThan(9.9 * 60_000);
    for (let i = 0; i < 6; i++) await ring(s, "counters");
    expect(sent(s, "shell.run").map((f) => [f.to, f.from, f.shell, f.script, f.timeout])).toEqual(Array(6).fill(["@laptop", ".factory", "bash", "node checks/counters.mjs", 60]));
    expect(await tickets(s)).toEqual([]);
    expect(gives(s)).toHaveLength(0);
    expect(sent(s, "session.open")).toHaveLength(opened);
    expect(ruleLines(s)).toEqual(Array(6).fill({ outcome: "quiet", machine: "laptop", project: "site", rule: "counters", source: "time", code: 0, ms: 840 }));
    // пауза: правило не срабатывает — проверки нет, строка «пропущено»
    await s.ask("factory.pause", { project: "site", on: true });
    await ring(s, "counters");
    expect(sent(s, "shell.run")).toHaveLength(6);
    expect(ruleLines(s).at(-1)).toMatchObject({ outcome: "paused", rule: "counters" });
    await drop(s.env, s.fleet, { prefix: "factory/site/" });
  });

  // эталон 6 — чьё: факт (политика наложения у Paperclip и gh-aw: повторное событие не заводит вторую работу)
  it("6 · повтор не плодит тикеты: находка — тикет посту; три следующие с тем же ключом — тикет 1, заметок 3; закрыт — находка заводит новый", async () => {
    const { s } = await applied({ ...DEF, on: [COUNTERS] }, CH);
    checks(s, 1, "потерь за час: 4");
    await ring(s, "counters");
    const [first] = await tickets(s);
    expect(first).toMatchObject({ id: "site-1", to: "cto", on: "counters", key: "counters", state: "work", session: "cto@laptop", by: ".factory", title: "counters" });
    expect((await one(s, "site-1")).text).toBe("Разбери находку счётчиков.\n\nпроверка «node checks/counters.mjs» не прошла: код 1\nпотерь за час: 4");
    // имя правила идёт машине вместе с тикетом: текст находки для сессии — данные, а не команды; вопросы сессии по тикету правила — человеку из call проекта
    expect(gives(s)).toMatchObject([{ to: "@laptop", name: "cto", ticket: "site-1", on: "counters", key: "counters", asker: "~yuri@example.com" }]);
    for (let i = 0; i < 3; i++) await ring(s, "counters");
    expect(await tickets(s)).toHaveLength(1);
    const notes = (await one(s, "site-1")).notes!;
    expect(notes.map((n) => [n.by, n.verdict, n.text.includes("потерь за час: 4")])).toEqual(Array(3).fill([".factory", undefined, true]));
    expect(gives(s)).toHaveLength(1);
    expect(ruleLines(s).map((l) => [l.outcome, l.ticket, l.code])).toEqual([["ticket", "site-1", 1], ["note", "site-1", 1], ["note", "site-1", 1], ["note", "site-1", 1]]);
    // три находки пришли, пока пост вёл тикет: «сдал» один раз возвращается с их текстом — пост закрывает тикет, зная о них
    const unread = await as(s, "cto@laptop", "ticket.set", { ticket: "site-1", verdict: "done", note: "утечка закрыта" });
    expect(unread).toMatchObject({ ok: false, error: "unread" });
    expect(String(unread.why)).toContain("Заметки к тикету (3):");
    expect(await as(s, "cto@laptop", "ticket.set", { ticket: "site-1", verdict: "done", note: "утечка закрыта" })).toMatchObject({ ok: true, result: { state: "done" } });
    // пост закрыл тикет — следующая находка заводит новый
    await ring(s, "counters");
    expect((await tickets(s)).map((t) => [t.id, t.state])).toEqual([["site-2", "work"], ["site-1", "done"]]);
    await close(s);
    await drop(s.env, s.fleet, { prefix: "factory/site/" });
  });

  it("правило по расписанию без проверки заводит тикет каждый срок; машина проверки не ответила — не находка; снятое правило уходит с часов, прежнее идёт как шло", async () => {
    const { s, file } = await applied({ ...DEF, on: [COUNTERS, RETRO] }, CH);
    const clock = async () => (await list(s.env, s.fleet, "factory/site/on/")).map((t) => [t.id, t.every ?? t.cron, t.tz]).sort();
    expect(await clock()).toEqual([["factory/site/on/counters", 600_000, undefined], ["factory/site/on/retro", "0 9 * * 1", "Europe/Kyiv"]]);
    // машина проверки не на связи: проверки не было — тикета нет, в истории причина
    s.state.answer = (f) => (f.type === "shell.run" ? fail(f.id!, "offline", "машина laptop не на связи") : f.id ? ok(f.id, { got: f.type }) : null);
    await ring(s, "counters");
    expect(await tickets(s)).toEqual([]);
    expect(ruleLines(s)).toMatchObject([{ outcome: "failed", rule: "counters", machine: "laptop" }]);
    // расписание: понедельник, 09:00 по Киеву — тикет посту с названием из правила; срок правила «каждые 10 минут» тоже пришёл — тихо
    checks(s, 0);
    const monday = (await dues(s)).retro!;
    expect(new Date(monday).getUTCDay()).toBe(1);
    expect(await tick(s, monday)).toBe(2);
    expect(await tickets(s)).toMatchObject([{ id: "site-1", to: "cto", on: "retro", key: "retro", title: "Недельная ретроспектива", state: "work" }]);
    expect(ruleLines(s).filter((l) => l.rule === "retro")).toMatchObject([{ outcome: "ticket", ticket: "site-1", source: "time", machine: "" }]);
    // новый коммит: расписание ретроспективы снято, правило счётчиков прежнее — его срок не сдвинут
    const counters = (await dues(s)).counters!;
    file.text = JSON.stringify({ ...DEF, on: [COUNTERS] });
    file.sha = "c2";
    expect(await s.ask("factory.apply", { project: "site", repo: "team/roles" })).toMatchObject({ ok: true, result: { commit: "c2", rules: 1 } });
    expect(await dues(s)).toEqual({ counters });
    // срок правила изменён — правило стоит заново, от «сейчас»
    file.text = JSON.stringify({ ...DEF, on: [{ ...COUNTERS, every: "5m" }] });
    file.sha = "c3";
    await s.ask("factory.apply", { project: "site", repo: "team/roles" });
    expect(await clock()).toEqual([["factory/site/on/counters", 300_000, undefined]]);
    expect((await dues(s)).counters!).toBeLessThan(counters);
    await close(s);
    await drop(s.env, s.fleet, { prefix: "factory/site/" });
  });

  it("битое правило входа не применяется: входов больше одного, негодное расписание, поста нет, машины нет, предел проверки больше запроса, имя дважды, проверка без срока", async () => {
    const { s, file } = await applied();
    file.text = JSON.stringify({
      ...DEF,
      on: [
        { name: "a", every: "10m", cron: "0 9 * * 1", to: "cto" },
        { name: "b", cron: "каждый день", to: "cto" },
        { name: "c", every: "10m", to: "nowhere" },
        { name: "d", every: "10m", to: "cto", check: { at: "@nowhere", run: "node check.mjs", for: "5m" } },
        { name: "d", every: "10m", tz: "Europe/Kyiv", to: "coders" },
        { name: "e", hook: true, every: "10m", to: "cto" },
        { name: "f", hook: true, to: "cto", check: { at: "@laptop", run: "node check.mjs", for: "30s" } },
      ],
    });
    file.sha = "c2";
    const r = await s.ask("factory.apply", { project: "site", repo: "team/roles" });
    expect(r).toMatchObject({ ok: false, error: "bad_factory" });
    for (const part of [
      "on[0]: у правила не больше одного входа", "on[1].cron: расписание «каждый день»", "on[2].to: поста nowhere нет в posts", "on[3].check.at: машины nowhere нет",
      "on[3].check.for: предел проверки правила — не больше 90s", "on[4].name: правило d уже есть", "on[4].tz: часовой пояс бывает у cron", "on[5]: у правила не больше одного входа", "on[6].check: проверка бывает у правила со сроком",
    ]) expect(r.why).toContain(part);
    expect(await list(s.env, s.fleet, "factory/site/on/")).toEqual([]);
    expect(await factoryState(s)).toMatchObject({ commit: "c1", next: {} });
  });

  it("тикет со сроком заводится спящим: до своего момента места не берёт; момент пришёл — в очередь поста и в работу; без исполнителя спать нельзя", async () => {
    const { s } = await applied();
    const later = await make(s, "coders", "Проверить выкладку через 20 минут", { in: "20m" });
    const t = await one(s, later);
    expect(t.state).toBe("wait");
    expect(t.start! - Date.now()).toBeGreaterThan(19 * 60_000);
    expect(gives(s)).toHaveLength(0);
    // тикет без срока спящего не ждёт
    const now = await make(s, "coders", "Срочное");
    expect(gives(s).map((g) => g.ticket)).toEqual([now]);
    expect(await tick(s, t.start! - 1)).toBe(0);
    expect(await tick(s, t.start!)).toBe(1);
    expect(gives(s).map((g) => g.ticket)).toEqual([now, later]);
    expect(await one(s, later)).toMatchObject({ state: "work", session: "coders-2@laptop" });
    expect(await s.ask("ticket.new", { project: "site", title: "Некому", in: "20m" })).toMatchObject({ ok: false, error: "bad_input" });
    await close(s);
  });
});
