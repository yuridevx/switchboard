// Эталоны «Фабрики»: определение проекта из git, посты, конвейер с шагами пяти видов, два потолка, обязательный срок, пауза;
// правила входа по времени с проверкой-скриптом и отложенный тикет; опрос чужого апстрима.
import { describe, expect, it } from "vitest";
import { fail, type FactoryState, type Frame, ok, type Ticket } from "@sb/protocol";
import type { Env, Outside } from "../env.ts";
import { appliedFleet, factoryFleet } from "../../test/factory.ts";
import type { Stand } from "../../test/stand.ts";
import { drop, fire, list } from "./clock/clock.ts";

const POST = (at: string, extra: Record<string, unknown> = {}) => ({ at, cwd: "~/work/post", key: "claude", model: "claude-opus-5-5", for: "1d", ...extra });
/** Определение проекта «site»: два поста и конвейеры — полный (пять видов шагов), одношаговый, с потолком один и с ожиданием. */
const DEF = {
  project: "site", limit: 3, call: ["~yuri@example.com"],
  posts: { "dev-fight": POST("@laptop", { pieces: ["team/roles/designer"] }), cto: POST("@laptop") },
  lines: {
    design: {
      title: "Дизайн", limit: 2, for: "8h", at: ["@laptop"], cwd: "~/work/{id}", key: "claude", model: "claude-opus-5-5",
      steps: [
        { name: "дизайн", post: "dev-{tag}" },
        { name: "вердикт", human: true },
        { name: "срезы", session: "same", check: { run: "sh gate.sh", for: "20m" } },
        { name: "ревью", session: "new", pieces: ["team/roles/reviewer"], do: "Проверь срезы тикета {id}." },
        { name: "слияние", wait: "pr.merged", for: "3d" },
      ],
    },
    solo: { limit: 2, for: "2h", at: ["@laptop", "@server"], cwd: "~/work/{id}", key: "claude", model: "claude-sonnet-5-5", steps: [{ name: "сделать", session: "new" }] },
    one: { limit: 1, for: "2h", at: ["@laptop"], cwd: "~/work/{id}", key: "claude", model: "claude-sonnet-5-5", steps: [{ name: "сделать", session: "new" }] },
    gate: { limit: 1, at: ["@laptop"], cwd: "~", steps: [{ name: "слияние", wait: "pr.merged", for: "3d" }] },
  },
};

const applied = (def: unknown = DEF, env?: Partial<Env>) => appliedFleet(def, env);
const sent = (s: Stand, type: string) => s.seen.delivered.filter((f) => f.type === type);
const gives = (s: Stand) => sent(s, "work.give");
const one = async (s: Stand, id: string) => ((await s.ask("ticket.list", { ticket: id })).result as { tickets: Ticket[] }).tickets[0]!;
const outside = (s: Stand): Outside => ({ platform: s.platform, fetch: s.deps.fetch!, log: { info() {}, warn() {}, error() {}, with() { return this; } } as never });
/** Запрос от имени сессии машины laptop. */
const as = (s: Stand, callsign: string, type: string, fields: Record<string, unknown>) => s.ask(type, fields, "klaptop", callsign);
const make = async (s: Stand, to: string, title: string, extra: Record<string, unknown> = {}) => ((await s.ask("ticket.new", { project: "site", to, title, ...extra })).result as { id: string }).id;
/** Снять всё, что осталось в работе и ожидании: сроки уходят с часов. */
async function close(s: Stand) {
  for (const state of ["work", "wait", "ready"]) for (const t of ((await s.ask("ticket.list", { project: "site", state })).result as { tickets: Ticket[] }).tickets) await s.ask("ticket.set", { ticket: t.id, drop: true });
}

describe("фабрика: определение проекта", () => {
  // эталон 9 — чьё: факт (определение в одном файле git с отказом целиком — приём открытых фабрик; слово пользователя — «определение всей системы в git»)
  it("9 · битое определение не применяется: отказ называет путь к месту в файле, действует прежний коммит", async () => {
    const { s, file, result } = await applied();
    expect(result).toMatchObject({ commit: "c1", posts: 2, lines: 4, failed: [] });
    // применение открывает посты, которых ещё нет
    expect(result.opened.sort()).toEqual(["cto@laptop", "dev-fight@laptop"]);
    expect(sent(s, "session.open").map((f) => [f.to, (f.spec as { name: string; project: string }).name, (f.spec as { project: string }).project]).sort()).toEqual([["@laptop", "cto", "site"], ["@laptop", "dev-fight", "site"]]);
    const state = async () => ((await s.ask("factory.get", { project: "site" })).result as { factory: FactoryState }).factory;
    expect(await state()).toMatchObject({ project: "site", repo: "team/roles", commit: "c1", paused: false, load: { work: 0, lines: { design: { work: 0, ready: 0 } } } });
    // новый коммит: шаг называет пост, которого нет; шагу сессии не назван срок; роль — из чужого репозитория; машины нет
    const broken = structuredClone(DEF) as any;
    broken.lines.design.steps[0] = { name: "дизайн", post: "ghost" };
    delete broken.lines.solo.for;
    broken.lines.design.steps[3].pieces = ["other/repo/reviewer"];
    broken.posts.cto.at = "@nowhere";
    file.text = JSON.stringify(broken);
    file.sha = "c2";
    const r = await s.ask("factory.apply", { project: "site", repo: "team/roles" });
    expect(r).toMatchObject({ ok: false, error: "bad_factory" });
    for (const part of ["lines.design.steps[0]: поста ghost нет в posts", "lines.solo.steps[0]: у шага сессии нет срока", "lines.design.steps[3].pieces: роли other/repo/reviewer нет", "posts.cto.at: машины nowhere нет"]) expect(r.why).toContain(part);
    expect((await state()).commit).toBe("c1");
    // не JSON, чужой проект, файл без известного ключа, репозиторий не из списка флота, файла нет
    for (const [text, part] of [["{", "не JSON"], [JSON.stringify({ ...DEF, project: "other" }), "project: в файле other"], [JSON.stringify({ ...DEF, extra: 1 }), "extra"]] as const) {
      file.text = text;
      const bad = await s.ask("factory.apply", { project: "site", repo: "team/roles" });
      expect(bad).toMatchObject({ ok: false, error: "bad_factory" });
      expect(bad.why).toContain(part);
    }
    expect(await s.ask("factory.apply", { project: "site", repo: "team/other" })).toMatchObject({ ok: false, error: "bad_factory" });
    file.text = "";
    expect(await s.ask("factory.apply", { project: "site", repo: "team/roles" })).toMatchObject({ ok: false, error: "no_file" });
    expect((await state()).commit).toBe("c1");
    // человеку без проекта — его проекты с определением; не участнику — отказ; проекту без определения — no_factory
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
    expect(await s.ask("factory.apply", { project: "site", repo: "team/roles/site-roles" })).toMatchObject({ ok: true, result: { commit: "c1", posts: 2, lines: 4 } });
    expect(((await s.ask("factory.get", { project: "site" })).result as { factory: FactoryState }).factory).toMatchObject({ repo: "team/roles/site-roles", commit: "c1" });
    // кусочек чужого репозитория и выход из папки — отказ, действует прежнее
    for (const repo of ["team/other/site-roles", "team/roles/../x"]) expect(await s.ask("factory.apply", { project: "site", repo })).toMatchObject({ ok: false, error: "bad_factory" });
    expect(((await s.ask("factory.get", { project: "site" })).result as { factory: FactoryState }).factory.commit).toBe("c1");
    await close(s);
  });
});

describe("фабрика: конвейер", () => {
  it("шаги пяти видов: пост по метке → человек → та же сессия с проверкой → свежая сессия → событие; закрыт — свежая убрана, пост остался (эталон 14)", async () => {
    const { s } = await applied();
    const id = await make(s, "design", "Уклонение от ударов по земле", { tag: "fight", text: "Готово: дизайн с эталонами." });
    // шаг 1 — пост dev-fight: документ поста идёт машине, чтобы она открыла его, если сессии нет
    expect(gives(s).at(-1)).toMatchObject({ to: "@laptop", name: "dev-fight", ticket: id, step: "дизайн", spec: { name: "dev-fight", cwd: "~/work/post", project: "site", pieces: ["team/roles/designer"] } });
    expect(await one(s, id)).toMatchObject({ state: "work", step: 0, session: "dev-fight@laptop" });
    expect(await as(s, "dev-fight@laptop", "ticket.set", { ticket: id, verdict: "done", note: "дизайн готов, 2 среза" })).toMatchObject({ ok: true, result: { state: "wait", step: 1 } });
    // шаг 2 — человек: сессии нет, места под потолком тикет не занимает
    expect(((await s.ask("factory.get", { project: "site" })).result as { factory: FactoryState }).factory.load.lines.design).toEqual({ work: 0, ready: 0 });
    expect(gives(s)).toHaveLength(1);
    expect(await s.ask("ticket.set", { ticket: id, verdict: "done", note: "принято" })).toMatchObject({ ok: true, result: { state: "ready", step: 2 } });
    // шаг 3 — та же сессия; у шага проверка: её называет тикет
    expect(gives(s).at(-1)).toMatchObject({ name: "dev-fight", step: "срезы" });
    expect(String(gives(s).at(-1)!.text)).toContain("Сдано на прошлом шаге: принято");
    expect(await one(s, id)).toMatchObject({ state: "work", step: 2, session: "dev-fight@laptop", check: { run: "sh gate.sh", for: "20m" } });
    await as(s, "dev-fight@laptop", "ticket.set", { ticket: id, verdict: "done", note: "срезы слиты", pr: "team/site#218" });
    // шаг 4 — свежая сессия: имя по тикету и шагу, папка с номером тикета, роль шага
    const review = gives(s).at(-1)!;
    expect(review).toMatchObject({ to: "@laptop", name: "site-1-s4", step: "ревью", spec: { name: "site-1-s4", cwd: "~/work/site-1", key: "claude", model: "claude-opus-5-5", pieces: ["team/roles/reviewer"], project: "site" } });
    expect(String(review.text)).toContain("Шаг «ревью» конвейера «Дизайн».");
    expect(String(review.text)).toContain("Проверь срезы тикета site-1.");
    expect(await one(s, id)).toMatchObject({ state: "work", step: 3, session: "site-1-s4@laptop", pr: "team/site#218" });
    await as(s, "site-1-s4@laptop", "ticket.set", { ticket: id, verdict: "done", note: "замечаний нет" });
    // шаг 5 — событие: срок обязателен и стоит на часах
    const wait = await one(s, id);
    expect(wait).toMatchObject({ state: "wait", step: 4 });
    expect(wait.until! - Date.now()).toBeGreaterThan(2.9 * 86_400_000);
    expect(sent(s, "session.remove")).toHaveLength(0);
    expect(await s.ask("ticket.set", { ticket: id, verdict: "done", note: "PR слит" })).toMatchObject({ ok: true, result: { state: "done" } });
    // эталон 14 — чьё: факт (справка флота «работа принята — убери дочь»; у PoE2 разовые сессии убирали себя сами)
    expect(sent(s, "session.remove").map((f) => [f.to, f.after_turn])).toEqual([["site-1-s4@laptop", true]]);
    expect((await one(s, id)).notes!.map((n) => [n.by, n.verdict])).toEqual([["dev-fight@laptop", "done"], ["pult~yuri@example.com", "done"], ["dev-fight@laptop", "done"], ["site-1-s4@laptop", "done"], ["pult~yuri@example.com", "done"]]);
    expect(await list(s.env, s.fleet, "factory/site/")).toEqual([]);
  });

  // эталон 4 — чьё: факт (устав Феникса «вторая правка одного места уходит в дизайн»; у Stripe два круга исправления)
  it("4 · второй возврат на одном шаге — «стоп»: ревью вернуло срезы дважды, сессии больше не запускаются; возврат ведёт та же сессия", async () => {
    const { s } = await applied();
    const id = await make(s, "design", "Навигация по узким мостам", { tag: "fight" });
    await as(s, "dev-fight@laptop", "ticket.set", { ticket: id, verdict: "done" });
    await s.ask("ticket.set", { ticket: id, verdict: "done" });
    await as(s, "dev-fight@laptop", "ticket.set", { ticket: id, verdict: "done" });
    // ревью возвращает: тикет идёт назад, на ближайший шаг с сессией — «срезы», той же сессии, с замечанием
    expect(await as(s, "site-1-s4@laptop", "ticket.set", { ticket: id, verdict: "back", note: "срез 2 дублирует службу знания" })).toMatchObject({ ok: true, result: { state: "ready", step: 2 } });
    expect(gives(s).at(-1)).toMatchObject({ name: "dev-fight", step: "срезы" });
    expect(String(gives(s).at(-1)!.text)).toContain("Вернули с замечанием: срез 2 дублирует службу знания");
    await as(s, "dev-fight@laptop", "ticket.set", { ticket: id, verdict: "done" });
    // второй круг ревью ведёт та же свежая сессия; второй возврат — стоп
    expect(gives(s).at(-1)).toMatchObject({ name: "site-1-s4", step: "ревью" });
    const n = gives(s).length;
    expect(await as(s, "site-1-s4@laptop", "ticket.set", { ticket: id, verdict: "back", note: "снова дубль" })).toMatchObject({ ok: true, result: { state: "stop" } });
    expect(await one(s, id)).toMatchObject({ state: "stop", why: "второй возврат", returns: 2 });
    expect(gives(s)).toHaveLength(n);
    await close(s);
  });

  // эталон 18 (половина служб) — чьё: слово пользователя («серия сессий с приёмкой»): возврат проверки записывает машина сессии, шаг остаётся у той же сессии
  it("18 · проверка держит «сдал»: возврат от машины сессии оставляет шаг в работе у той же сессии; второй — «стоп»", async () => {
    const { s } = await applied();
    const id = await make(s, "design", "Подбор камней", { tag: "fight" });
    await as(s, "dev-fight@laptop", "ticket.set", { ticket: id, verdict: "done" });
    await s.ask("ticket.set", { ticket: id, verdict: "done" });
    const n = gives(s).length;
    expect(await s.ask("ticket.set", { ticket: id, verdict: "back", note: "проверка «sh gate.sh» не прошла: код 1\nтест 7 красный" }, "klaptop")).toMatchObject({ ok: true, result: { state: "work", step: 2 } });
    expect(await one(s, id)).toMatchObject({ state: "work", step: 2, session: "dev-fight@laptop", returns: 1 });
    expect(gives(s)).toHaveLength(n);
    // вторая проверка прошла: «сдал» принят
    expect(await as(s, "dev-fight@laptop", "ticket.set", { ticket: id, verdict: "done" })).toMatchObject({ ok: true, result: { step: 3 } });
    await close(s);
  });

  // эталон 2 — чьё: слово пользователя («максимальный параллелизм у конвейера»)
  it("2 · потолок держится: пять тикетов при потолке два — в работе два; после вердикта стартует третий, старший; машины делят шаги", async () => {
    const { s } = await applied();
    for (let i = 1; i <= 5; i++) await make(s, "solo", "Задача " + i);
    expect(gives(s).map((g) => g.ticket)).toEqual(["site-1", "site-2"]);
    // свежие сессии встают на разные машины списка конвейера
    expect(gives(s).map((g) => g.to).sort()).toEqual(["@laptop", "@server"]);
    const load = async () => ((await s.ask("factory.get", { project: "site" })).result as { factory: FactoryState }).factory.load;
    expect(await load()).toMatchObject({ work: 2, lines: { solo: { work: 2, ready: 3 } } });
    await s.ask("ticket.set", { ticket: "site-2", verdict: "done" });
    expect(gives(s).map((g) => g.ticket)).toEqual(["site-1", "site-2", "site-3"]);
    expect(await load()).toMatchObject({ work: 2, lines: { solo: { work: 2, ready: 2 } } });
    // потолок проекта — три шага по всем конвейерам: третий конвейер получает одно место
    await make(s, "one", "Ещё конвейер");
    await make(s, "design", "И ещё", { tag: "fight" });
    expect((await load()).work).toBe(3);
    await close(s);
  });

  // эталон 1 — чьё: факт (взятие одной условной записью — приём Beads и Paperclip)
  it("1 · место берёт один: свободно одно место, два события приходят разом — запущен один шаг, второй тикет в очереди", async () => {
    const { s } = await applied();
    await Promise.all([make(s, "one", "Первый"), make(s, "one", "Второй")]);
    expect(gives(s)).toHaveLength(1);
    const states = [(await one(s, "site-1")).state, (await one(s, "site-2")).state].sort();
    expect(states).toEqual(["ready", "work"]);
    await close(s);
  });

  // эталон 13 — чьё: слово владельца PoE2 13 нояб. («на паузу, с которой можно восстановиться»)
  it("13 · пауза: идущие шаги сдаются, новых запусков нет; пауза снята — очередь идёт", async () => {
    const { s } = await applied();
    for (let i = 1; i <= 5; i++) await make(s, "solo", "Задача " + i);
    expect(gives(s)).toHaveLength(2);
    expect(await s.ask("factory.pause", { project: "site", on: true })).toMatchObject({ ok: true, result: { paused: true } });
    expect(await s.ask("ticket.set", { ticket: "site-1", verdict: "done" })).toMatchObject({ ok: true, result: { state: "done" } });
    expect(await s.ask("ticket.set", { ticket: "site-2", verdict: "done" })).toMatchObject({ ok: true, result: { state: "done" } });
    await make(s, "solo", "Пришёл на паузе");
    expect(gives(s)).toHaveLength(2);
    expect(((await s.ask("factory.get", { project: "site" })).result as { factory: FactoryState }).factory).toMatchObject({ paused: true, load: { lines: { solo: { work: 0, ready: 4 } } } });
    await s.ask("factory.pause", { project: "site", on: false });
    expect(gives(s).map((g) => g.ticket)).toEqual(["site-1", "site-2", "site-3", "site-4"]);
    await close(s);
  });

  // эталон 17 — чьё: слово пользователя («у всех операций должен быть лимит»)
  it("17 · срок вышел — «стоп»: шаг сессии без вердикта и ожидание события без события; свежая сессия шага остановлена, повторов нет", async () => {
    const { s } = await applied();
    const work = await make(s, "solo", "Долгий шаг");
    const wait = await make(s, "gate", "Ждём слияния");
    expect(await one(s, wait)).toMatchObject({ state: "wait", step: 0 });
    const untilWork = (await one(s, work)).until!, untilWait = (await one(s, wait)).until!;
    expect(untilWork - Date.now()).toBeGreaterThan(1.9 * 3600_000);
    expect(untilWait - Date.now()).toBeGreaterThan(2.9 * 86_400_000);
    const n = gives(s).length;
    expect(await fire(s.env, s.fleet, outside(s), untilWork + 1)).toBe(1);
    expect(await one(s, work)).toMatchObject({ state: "stop", why: "срок вышел" });
    expect(sent(s, "session.stop").map((f) => f.to)).toEqual([(await one(s, work)).session]);
    expect(await fire(s.env, s.fleet, outside(s), untilWait + 1)).toBe(1);
    expect(await one(s, wait)).toMatchObject({ state: "stop", why: "срок вышел" });
    expect(gives(s)).toHaveLength(n);
    expect(await list(s.env, s.fleet, "factory/site/")).toEqual([]);
  });

  it("тикет посту: документ поста идёт машине, пост берёт тикеты по одному; исполнителя нет — отказ; под метку нет поста — отказ", async () => {
    const { s } = await applied();
    const a = await make(s, "cto", "Ретро недели");
    const b = await make(s, "cto", "Вопрос владельца");
    expect(gives(s).map((g) => [g.ticket, g.name, (g.spec as { cwd?: string } | undefined)?.cwd])).toEqual([[a, "cto", "~/work/post"]]);
    expect((await one(s, b)).state).toBe("ready");
    // заметка к тикету в очереди доходит до сессии вместе с шагом
    await s.ask("ticket.set", { ticket: b, note: "сначала спроси владельца про сроки" });
    await as(s, "cto@laptop", "ticket.set", { ticket: a, verdict: "done" });
    expect(gives(s).map((g) => g.ticket)).toEqual([a, b]);
    expect(String(gives(s).at(-1)!.text)).toContain("Заметки к тикету (1):\n— pult~yuri@example.com: сначала спроси владельца про сроки");
    expect(await s.ask("ticket.new", { project: "site", to: "nowhere", title: "Некому" })).toMatchObject({ ok: false, error: "no_dest" });
    expect(await s.ask("ticket.new", { project: "site", to: "design", tag: "magic", title: "Нет поста под метку" })).toMatchObject({ ok: false, error: "no_dest" });
    // бэклог → назначить конвейеру: срок у конвейера свой
    const c = ((await s.ask("ticket.new", { project: "site", title: "Когда-нибудь" })).result as { id: string }).id;
    expect(await s.ask("ticket.set", { ticket: c, to: "solo" })).toMatchObject({ ok: true, result: { state: "ready" } });
    expect(gives(s).at(-1)).toMatchObject({ ticket: c, name: "site-3-s1" });
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
const dues = async (s: Stand) => ((await s.ask("factory.get", { project: "site" })).result as { factory: FactoryState }).factory.next;
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
    expect(first!.text).toBe("Разбери находку счётчиков.\n\nпроверка «node checks/counters.mjs» не прошла: код 1\nпотерь за час: 4");
    // имя правила идёт машине вместе с шагом: текст находки для сессии — данные, а не команды; вопросы сессии по тикету правила — человеку из call проекта
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

  it("битое правило входа не применяется: входов больше одного, негодное расписание, исполнителя нет, машины нет, предел проверки больше запроса, имя дважды, проверка без срока", async () => {
    const { s, file } = await applied();
    file.text = JSON.stringify({
      ...DEF,
      on: [
        { name: "a", every: "10m", cron: "0 9 * * 1", to: "cto" },
        { name: "b", cron: "каждый день", to: "cto" },
        { name: "c", every: "10m", to: "nowhere" },
        { name: "d", every: "10m", to: "cto", check: { at: "@nowhere", run: "node check.mjs", for: "5m" } },
        { name: "d", every: "10m", tz: "Europe/Kyiv", to: "solo" },
        { name: "e", hook: true, every: "10m", to: "cto" },
        { name: "f", hook: true, to: "cto", check: { at: "@laptop", run: "node check.mjs", for: "30s" } },
        { name: "g", github: "upstream.moved", repo: "ghost", to: "cto" },
        { name: "h", every: "5m", repo: "ghost", to: "cto" },
      ],
    });
    file.sha = "c2";
    const r = await s.ask("factory.apply", { project: "site", repo: "team/roles" });
    expect(r).toMatchObject({ ok: false, error: "bad_factory" });
    for (const part of [
      "on[0]: у правила не больше одного входа", "on[1].cron: расписание «каждый день»", "on[2].to: исполнителя nowhere нет", "on[3].check.at: машины nowhere нет",
      "on[3].check.for: предел проверки правила — не больше 90s", "on[4].name: правило d уже есть", "on[4].tz: часовой пояс бывает у cron", "on[5]: у правила не больше одного входа", "on[6].check: проверка бывает у правила со сроком",
      "on[7]: опросу апстрима нужен срок", "on[7].repo: опросу апстрима нужен репозиторий из repos, у которого назван upstream", "on[8].repo: репозиторий называют правилу с github",
    ]) expect(r.why).toContain(part);
    expect(await list(s.env, s.fleet, "factory/site/on/")).toEqual([]);
    expect(((await s.ask("factory.get", { project: "site" })).result as { factory: FactoryState }).factory).toMatchObject({ commit: "c1", next: {} });
  });

  it("отложенный тикет: до своего момента стоит в очереди и места не берёт; момент пришёл — ушёл в работу; без исполнителя отложить нельзя", async () => {
    const { s } = await applied();
    const later = await make(s, "solo", "Проверить выкладку через 20 минут", { in: "20m" });
    const t = await one(s, later);
    expect(t.state).toBe("ready");
    expect(t.start! - Date.now()).toBeGreaterThan(19 * 60_000);
    expect(gives(s)).toHaveLength(0);
    // тикет без отсрочки отложенного не ждёт
    const now = await make(s, "solo", "Срочное");
    expect(gives(s).map((g) => g.ticket)).toEqual([now]);
    expect(await tick(s, t.start! - 1)).toBe(0);
    expect(await tick(s, t.start!)).toBe(1);
    expect(gives(s).map((g) => g.ticket)).toEqual([now, later]);
    expect(await one(s, later)).toMatchObject({ state: "work" });
    expect(await s.ask("ticket.new", { project: "site", title: "Некому", in: "20m" })).toMatchObject({ ok: false, error: "bad_input" });
    await close(s);
  });
});

/* ===== Чужой апстрим ===== */

/** Проект ведёт форк team/site чужого author/site: правило раз в 5 минут спрашивает голову апстрима; конвейер fix кончается ожиданием PR. */
const FORK = {
  ...DEF,
  repos: { site: { repo: "team/site", upstream: "author/site" } },
  lines: { ...DEF.lines, fix: { limit: 2, for: "2h", at: ["@laptop"], cwd: "~/work/{id}", key: "claude", model: "claude-opus-5-5", steps: [{ name: "серия", session: "new" }, { name: "ответ апстрима", wait: "pr.merged", for: "14d" }] } },
  on: [{ name: "upstream", github: "upstream.moved", repo: "site", every: "5m", to: "cto", title: "Апстрим сдвинулся" }],
};
/** GitHub с чужим репозиторием author/site: голова ветки с отпечатком (условный запрос на прежнюю — 304) и PR с ревью. */
function fork(s: Stand) {
  const base = s.state.net;
  const hub = {
    sha: "a".repeat(40), down: false,
    pulls: {} as Record<number, { state: string; merged?: boolean; reviews?: { id: number; state: string; body: string; user: { login: string } }[] }>,
    /** ответы на запросы головы: код и отпечаток, с которым спросили */
    heads: [] as { status: number; etag?: string }[],
  };
  s.state.net = (url, init) => {
    const at = new URL(url).pathname;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (at === "/repos/team/site/installation") return Response.json({ id: 5 });
    if (at === "/repos/author/site/commits/HEAD") {
      if (hub.down) return new Response("{}", { status: 502 });
      const etag = `"${hub.sha.slice(0, 8)}"`;
      const same = headers["if-none-match"] === etag;
      hub.heads.push({ status: same ? 304 : 200, ...(headers["if-none-match"] ? { etag: headers["if-none-match"] } : {}) });
      return same ? new Response(null, { status: 304 }) : Response.json({ sha: hub.sha }, { headers: { etag } });
    }
    const pr = /^\/repos\/author\/site\/pulls\/(\d+)(\/reviews)?$/.exec(at);
    if (pr) return pr[2] ? Response.json(hub.pulls[Number(pr[1])]?.reviews ?? []) : hub.pulls[Number(pr[1])] ? Response.json(hub.pulls[Number(pr[1])]) : new Response("{}", { status: 404 });
    return base(url, init);
  };
  return hub;
}

describe("фабрика: чужой апстрим", () => {
  // эталон 12 — чьё: слово пользователя («оригинал репо + наш форк: ребейзимся на апстрим»)
  it("12 · апстрим сдвинулся — один тикет: первая сверка запоминает голову; новая голова — тикет посту; трижды прежняя — тикетов не прибавилось, запросы условные", async () => {
    const { s, result } = await applied(FORK, CH);
    expect(result.rules).toBe(1);
    const hub = fork(s);
    // первая сверка: голова запомнена, сдвига ещё не было
    await ring(s, "upstream");
    expect(await tickets(s)).toEqual([]);
    hub.sha = "b".repeat(40);
    await ring(s, "upstream");
    expect(await tickets(s)).toMatchObject([{ id: "site-1", to: "cto", on: "upstream", title: "Апстрим сдвинулся", text: "Апстрим author/site сдвинулся: aaaaaaa → bbbbbbb", state: "work", by: ".factory" }]);
    for (let i = 0; i < 3; i++) await ring(s, "upstream");
    expect(await tickets(s)).toHaveLength(1);
    expect((await one(s, "site-1")).notes).toEqual([]);
    expect(gives(s)).toHaveLength(1);
    // три запроса на прежнюю голову — условные, с её отпечатком: ответ «не изменилось» в предел GitHub не идёт
    expect(hub.heads).toEqual([{ status: 200 }, { status: 200, etag: '"aaaaaaaa"' }, { status: 304, etag: '"bbbbbbbb"' }, { status: 304, etag: '"bbbbbbbb"' }, { status: 304, etag: '"bbbbbbbb"' }]);
    expect(ruleLines(s).map((l) => [l.source, l.outcome, l.repo, l.ticket])).toEqual([
      ["github", "quiet", "author/site", undefined], ["github", "ticket", "author/site", "site-1"], ["github", "quiet", "author/site", undefined], ["github", "quiet", "author/site", undefined], ["github", "quiet", "author/site", undefined],
    ]);
    // сдвиг при открытом тикете дописывается в него; GitHub не ответил — строка с причиной, тикетов не прибавилось
    hub.sha = "c".repeat(40);
    await ring(s, "upstream");
    expect((await one(s, "site-1")).notes!.map((n) => n.text)).toEqual(["Апстрим author/site сдвинулся: bbbbbbb → ccccccc"]);
    hub.down = true;
    await ring(s, "upstream");
    expect(ruleLines(s).at(-1)).toMatchObject({ outcome: "failed", source: "github" });
    expect(await tickets(s)).toHaveLength(1);
    await close(s);
    await drop(s.env, s.fleet, { prefix: "factory/site/" });
  });

  it("PR в апстриме опрашивается, пока тикет ждёт: ревью с замечаниями возвращает шаг автору один раз; слит — шаг сдан; закрыт — «стоп»", async () => {
    const { s } = await applied(FORK);
    const hub = fork(s);
    const wait = async (title: string, pr: string) => {
      const id = await make(s, "fix", title);
      expect(await as(s, (await one(s, id)).session!, "ticket.set", { ticket: id, verdict: "done", note: "PR открыт", pr })).toMatchObject({ ok: true, result: { state: "wait", step: 1 } });
      return id;
    };
    const a = await wait("Патч обхода", "author/site#12");
    hub.pulls[12] = { state: "open" };
    await ring(s, "upstream");
    expect(await one(s, a)).toMatchObject({ state: "wait", step: 1 });
    // ревью просит правок: шаг возвращён автору с его словами
    hub.pulls[12] = { state: "open", reviews: [{ id: 501, state: "COMMENTED", body: "гляну", user: { login: "author" } }, { id: 502, state: "CHANGES_REQUESTED", body: "разбей патч на два", user: { login: "author" } }] };
    await ring(s, "upstream");
    expect(await one(s, a)).toMatchObject({ state: "work", step: 0, returns: 1 });
    expect(String(gives(s).at(-1)!.text)).toContain("Вернули с замечанием: замечания ревью PR author/site#12 от author: разбей патч на два");
    // автор поправил и снова ждёт тот же PR: то же ревью второй раз шаг не возвращает
    expect(await as(s, (await one(s, a)).session!, "ticket.set", { ticket: a, verdict: "done", note: "разбил" })).toMatchObject({ ok: true, result: { state: "wait", step: 1 } });
    await ring(s, "upstream");
    expect(await one(s, a)).toMatchObject({ state: "wait", step: 1, returns: 1 });
    // апстрим принял: шаг сдан событием
    hub.pulls[12] = { state: "closed", merged: true };
    await ring(s, "upstream");
    const done = await one(s, a);
    expect(done).toMatchObject({ state: "done" });
    expect(done.notes!.at(-1)).toMatchObject({ by: ".github", verdict: "done", text: "PR author/site#12 слит" });
    // закрыт без слияния — «стоп»
    const b = await wait("Патч карты", "author/site#13");
    hub.pulls[13] = { state: "closed", merged: false };
    await ring(s, "upstream");
    expect(await one(s, b)).toMatchObject({ state: "stop", why: "PR author/site#13 закрыт без слияния" });
    await close(s);
    await drop(s.env, s.fleet, { prefix: "factory/site/" });
  });
});

/** Ответ машины по умолчанию у стенда — успех: отказ машины проверен в эталонах шага 2. */
export type { Frame };
