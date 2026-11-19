// Эталоны «Фабрики», шаг 3: определение проекта из git, посты, конвейер с шагами пяти видов, два потолка, обязательный срок, пауза.
import { describe, expect, it } from "vitest";
import { type FactoryState, type Frame, ok, type Ticket } from "@sb/protocol";
import type { Outside } from "../env.ts";
import { type Stand, stand } from "../../test/stand.ts";
import { fire } from "./clock/clock.ts";

/** Ключ приложения GitHub в PEM. */
async function pem(): Promise<string> {
  const pair = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign"])) as CryptoKeyPair;
  const der = new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
  return `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der)).replace(/(.{64})/g, "$1\n")}\n-----END PRIVATE KEY-----\n`;
}

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

/** Флот с проектом «site», приложением GitHub и репозиторием ролей team/roles; file — что сейчас лежит в factory.json и на каком коммите. */
async function fleet(file: { text: string; sha: string }): Promise<Stand> {
  const s = stand();
  s.state.fleetAnswer = (f) =>
    f.type === "people.list" ? ok(f.id!, { people: [], projects: [{ id: "site", name: "Сайт", members: ["~yuri@example.com", "~anya@example.com"] }] }) : ok(f.id!, { called: f.type });
  const key = await pem();
  s.state.net = (url) => {
    const path = new URL(url).pathname;
    if (path === "/app-manifests/code123/conversions") return Response.json({ id: 42, slug: "switchboard-test", owner: { login: "team" }, pem: key });
    if (path === "/repos/team/roles/installation") return Response.json({ id: 5 });
    if (path === "/app/installations/5/access_tokens") return Response.json({ token: "ghs_token", expires_at: "2027-01-01T00:00:00Z" });
    if (path === "/repos/team/roles/commits/HEAD") return Response.json({ sha: file.sha });
    if (path === "/repos/team/roles/contents/factory.json") return file.text ? Response.json({ content: Buffer.from(file.text).toString("base64"), encoding: "base64" }) : new Response("{}", { status: 404 });
    return new Response(null, { status: 201 });
  };
  expect((await s.ask("github.setup", { code: "code123" })).ok).toBe(true);
  await s.ask("prefs.set", { scope: "fleet", name: "profiles.repos", value: ["team/roles"] });
  return s;
}
const applied = async (def: unknown = DEF) => {
  const file = { text: JSON.stringify(def), sha: "c1" };
  const s = await fleet(file);
  const r = await s.ask("factory.apply", { project: "site", repo: "team/roles" });
  expect(r).toMatchObject({ ok: true });
  return { s, file, result: r.result as { commit: string; posts: number; lines: number; opened: string[]; failed: unknown[] } };
};
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
    expect(((await s.ask("clock.list", { prefix: "factory/" })).result as { timers: unknown[] }).timers).toEqual([]);
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
    expect(((await s.ask("clock.list", { prefix: "factory/" })).result as { timers: unknown[] }).timers).toEqual([]);
  });

  it("тикет посту: документ поста идёт машине, пост берёт тикеты по одному; исполнителя нет — отказ; под метку нет поста — отказ", async () => {
    const { s } = await applied();
    const a = await make(s, "cto", "Ретро недели");
    const b = await make(s, "cto", "Вопрос владельца");
    expect(gives(s).map((g) => [g.ticket, g.name, (g.spec as { cwd?: string } | undefined)?.cwd])).toEqual([[a, "cto", "~/work/post"]]);
    expect((await one(s, b)).state).toBe("ready");
    await as(s, "cto@laptop", "ticket.set", { ticket: a, verdict: "done" });
    expect(gives(s).map((g) => g.ticket)).toEqual([a, b]);
    expect(await s.ask("ticket.new", { project: "site", to: "nowhere", title: "Некому" })).toMatchObject({ ok: false, error: "no_dest" });
    expect(await s.ask("ticket.new", { project: "site", to: "design", tag: "magic", title: "Нет поста под метку" })).toMatchObject({ ok: false, error: "no_dest" });
    // бэклог → назначить конвейеру: срок у конвейера свой
    const c = ((await s.ask("ticket.new", { project: "site", title: "Когда-нибудь" })).result as { id: string }).id;
    expect(await s.ask("ticket.set", { ticket: c, to: "solo" })).toMatchObject({ ok: true, result: { state: "ready" } });
    expect(gives(s).at(-1)).toMatchObject({ ticket: c, name: "site-3-s1" });
    await close(s);
  });
});

/** Ответ машины по умолчанию у стенда — успех: отказ машины проверен в эталонах шага 2. */
export type { Frame };
