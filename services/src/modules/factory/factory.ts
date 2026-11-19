// Фабрика: тикеты и конвейеры флота. Тикет — единица работы проекта: исполнитель, шаг, состояние и заметки с вердиктами; записи — объект на проект.
// Исполнитель — конвейер или пост из определения проекта либо сессия по позывному. Определение — файл factory.json в репозитории ролей,
// применяется явным вызовом; битое не применяется. Шаг отдаётся сессии запросом «дать работу» её машине; кончает шаг вердикт — сессии,
// которая его ведёт, машины этой сессии или человека — либо срок. Тикеты заводят и правила входа из определения: по сроку правила
// идёт проверка-скрипт на машине, код 0 — тихо, иначе её вывод — находка: новый тикет или заметка в открытый с тем же ключом.
// Тем же событием правила приходит зов по имени (ticket.new {on}) и запрос на адрес с секретом (модуль «Входы»).
// Сама Фабрика ничего не чинит и не повторяет: отказ машины, второй возврат и вышедший срок ставят тикет в «стоп» с причиной.
import {
  CALL_MS, canReach, checkOutcome, checkRun, errFields, FACTORY, FACTORY_FILE, FactoryDef, type FactoryState, type FileIn, kindOf, type LineDef, machineOf, newId, type Project, Refusal,
  RULE_CHECK_MS, type RuleDef, sessionName, type Spec, type StepDef, termMs, type Ticket, type TicketNote, type TicketState, type Verdict, within,
} from "@sb/protocol";
import type { Ctx, Env, Module, Outside } from "../../env.ts";
import { type Op, records } from "../../records.ts";
import { line as historyLine } from "../analytics/contract.ts";
import { drop, list as timers, next, on, set } from "../clock/contract.ts";
import { file } from "../github/contract.ts";
import { fleetPref } from "../prefs/contract.ts";
import { sendTo } from "../reach/contract.ts";

const NAME = "factory";
/** Вид правила часов: срок шага в работе или ожидании. */
const TERM = "factory.term";
/** Вид правила часов: срок правила входа по времени. */
const RULE = "factory.rule";
/** Вид правила часов: отложенный тикет дождался своего момента. */
const START = "factory.start";
/** Возвратов на одном шаге: второй ставит тикет в «стоп». */
const RETURNS = 2;
/** Цель свежей сессии до взятия места: её машина выбирается, когда место взято. */
const FRESH = "*";
/** Настройка флота со списком репозиториев ролей: определение проекта читается только из них. */
const REPOS = "profiles.repos";
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS tickets (n INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, text TEXT NOT NULL, dest TEXT, step INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL, session TEXT, target TEXT, runs TEXT NOT NULL DEFAULT '{}', by TEXT NOT NULL, why TEXT, key TEXT, rule TEXT, tag TEXT, pr TEXT,
    returns INTEGER NOT NULL DEFAULT 0, backstep INTEGER, since INTEGER NOT NULL, moved INTEGER NOT NULL, term INTEGER, until INTEGER, start INTEGER,
    rank INTEGER NOT NULL DEFAULT 0, dropped INTEGER NOT NULL DEFAULT 0, files TEXT)`,
  "CREATE INDEX IF NOT EXISTS tickets_state ON tickets (state, dest)",
  "CREATE TABLE IF NOT EXISTS notes (n INTEGER NOT NULL, at INTEGER NOT NULL, by TEXT NOT NULL, verdict TEXT, text TEXT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS notes_n ON notes (n, at)",
  // применённое определение: откуда и с какого коммита; пауза — рядом с ним
  "CREATE TABLE IF NOT EXISTS def (one INTEGER PRIMARY KEY CHECK (one = 1), repo TEXT NOT NULL, sha TEXT NOT NULL, at INTEGER NOT NULL, by TEXT NOT NULL, json TEXT NOT NULL, paused INTEGER NOT NULL DEFAULT 0)",
];
const db = (env: Env, fleet: string, project: string) => records(env, fleet, NAME, SCHEMA, project);

/** Сессия, которая вела шаг: fresh — открыта этим тикетом и уйдёт вместе с ним. */
type Run = { s: string; fresh?: true };
type Stored = {
  n: number; title: string; text: string; dest: string | null; step: number; state: TicketState; session: string | null; target: string | null; runs: string;
  by: string; why: string | null; key: string | null; rule: string | null; tag: string | null; pr: string | null; returns: number; backstep: number | null;
  since: number; moved: number; term: number | null; until: number | null; start: number | null; rank: number; dropped: number; files: string | null;
};
type Applied = { repo: string; sha: string; at: number; paused: number; json: string };

const idOf = (project: string, n: number) => `${project}-${n}`;
/** Номер тикета → проект и порядковое число. */
function parse(id: string): { project: string; n: number } {
  const cut = id.lastIndexOf("-");
  const n = Number(id.slice(cut + 1));
  if (cut < 1 || !Number.isInteger(n) || n < 1) throw new Refusal("no_ticket", `${id} — не номер тикета: номер вида проект-число`);
  return { project: id.slice(0, cut), n };
}
const timer = (project: string, n: number) => `${NAME}/${project}/${n}`;
/** Имена правил часов у правил входа проекта: начало общее, чтобы прочитать и снять их разом. */
const ruleTimers = (project: string) => `${NAME}/${project}/on/`;
const runsOf = (s: Pick<Stored, "runs">) => JSON.parse(s.runs) as Record<string, Run>;
/** Подстановки определения: {id} — номер тикета, {tag} — его метка. */
const fill = (text: string, id: string, tag: string | null) => text.replaceAll("{id}", id).replaceAll("{tag}", tag ?? "");

/** Применённое определение проекта; нет — null. */
async function applied(env: Env, fleet: string, project: string): Promise<{ def: FactoryDef; row: Applied } | null> {
  const row = await db(env, fleet, project).first<Applied>("SELECT repo, sha, at, paused, json FROM def WHERE one = 1");
  return row ? { def: JSON.parse(row.json) as FactoryDef, row } : null;
}

const stepOf = (def: FactoryDef | null, s: Pick<Stored, "dest" | "step">): { line: LineDef; step: StepDef } | null => {
  const line = s.dest ? def?.lines[s.dest] : undefined;
  const step = line?.steps[s.step];
  return line && step ? { line, step } : null;
};

const ticket = (project: string, s: Stored, def: FactoryDef | null, notes?: TicketNote[]): Ticket => {
  const check = s.state === "work" ? stepOf(def, s)?.step.check : undefined;
  return {
    id: idOf(project, s.n), project, title: s.title, text: s.text, step: s.step, state: s.state, by: s.by, returns: s.returns, since: s.since, moved: s.moved,
    ...(s.dest ? { to: s.dest } : {}), ...(s.session ? { session: s.session } : {}), ...(s.why ? { why: s.why } : {}), ...(s.key ? { key: s.key } : {}), ...(s.tag ? { tag: s.tag } : {}),
    ...(s.pr ? { pr: s.pr } : {}), ...(s.rule ? { on: s.rule } : {}), ...(s.start ? { start: s.start } : {}), ...(s.until ? { until: s.until } : {}), ...(s.dropped ? { dropped: true } : {}),
    ...(s.files ? { files: JSON.parse(s.files) as FileIn[] } : {}), ...(check ? { check } : {}), ...(notes ? { notes } : {}),
  };
};

/** Проекты флота глазами пришедшего: все и те, где он участник. */
async function projects(ctx: Ctx): Promise<Project[]> {
  const r = await within(ctx.platform.fleetCall(ctx.fleet, ctx.who, { type: "people.list", id: newId("r"), trace: ctx.trace }), CALL_MS, "объект флота не назвал проекты");
  if (!r.ok) throw new Refusal(r.error ?? "offline", r.why ?? "объект флота не назвал проекты");
  return (r.result as { projects?: Project[] }).projects ?? [];
}

/** Проект есть, и пришедший — его участник или админ флота. */
async function member(ctx: Ctx, project: string): Promise<void> {
  const all = await projects(ctx);
  const p = all.find((x) => x.id === project);
  if (!p) throw new Refusal("no_project", `проекта ${project} нет: ${all.map((x) => `${x.id} — ${x.name}`).join(", ") || "проектов нет"}`);
  if (!ctx.who.admin && !p.members.includes(ctx.who.person)) throw new Refusal("forbidden", `проект ${project} — не ваш`);
}

/** Проект запроса: названный или проект сессии, которая пришла. */
async function projectOf(ctx: Ctx, named?: string): Promise<string> {
  let project = named;
  if (!project && kindOf(ctx.who.addr) === "session") project = (await within(ctx.platform.sessions(ctx.fleet), CALL_MS, "платформа не назвала сессии")).find((s) => s.callsign === ctx.who.addr)?.spec.project;
  if (!project) throw new Refusal("no_project", "назовите проект: project — номер из people_list");
  await member(ctx, project);
  return project;
}

/** Строка истории флота: движение тикета или событие определения. Машина — та, где сессия шага или исполнитель. Не записалась — строка журнала службы. */
function history(env: Env, w: Outside, fleet: string, l: { msg: string; kind: string; who?: string; text?: string; data: Record<string, unknown> }): Promise<void> {
  const who = l.who ?? "";
  return historyLine(env, w.fetch, fleet, { file: NAME, msg: l.msg, kind: l.kind, machine: machineOf(who) ?? "", session: kindOf(who) === "session" ? who : "", text: (l.text ?? "").slice(0, 500), data: l.data })
    .catch((e: unknown) => w.log.warn("строка истории фабрики не записалась", { module: NAME, fleet, ...errFields(e) }));
}
const trail = (env: Env, w: Outside, fleet: string, project: string, s: Stored, move: string, by: string, text = "") =>
  history(env, w, fleet, { msg: "ticket", kind: move, who: s.session ?? (kindOf(s.dest ?? "") === "session" ? s.dest! : by), text, data: { ticket: idOf(project, s.n), project, state: s.state, step: s.step, by, ...(s.dest ? { to: s.dest } : {}) } });

/** Позвать людей проекта: тикет ждёт человека или встал. Не ушло — строка журнала. */
async function call(env: Env, w: Outside, fleet: string, def: FactoryDef | null, title: string, text: string): Promise<void> {
  for (const to of def?.call ?? [])
    await sendTo({ env, fleet, platform: w.platform, fetch: w.fetch, log: w.log }, { to, title, text, kind: "ask", force: true }).catch((e: unknown) => w.log.warn("человек не позван", { module: NAME, fleet, to, ...errFields(e) }));
}

/** Запрос машине от имени службы: ответ или слова отказа. */
async function toMachine(w: Outside, fleet: string, trace: string, frame: Record<string, unknown> & { type: string; to: string }): Promise<{ ok: true; result?: unknown } | { ok: false; why: string }> {
  try {
    const r = await within(w.platform.deliver(fleet, { ...frame, id: newId("r"), trace, from: FACTORY }), CALL_MS, "машина не ответила");
    return r && !r.ok ? { ok: false, why: `${r.error}${r.why ? `: ${r.why}` : ""}` } : { ok: true, result: r?.result };
  } catch (e) {
    return { ok: false, why: e instanceof Refusal ? `${e.word}${e.why ? `: ${e.why}` : ""}` : errFields(e).why ?? String(e) };
  }
}

/* ===== Шаг: кто его ведёт ===== */

/** Куда встаёт тикет на шаге: в очередь к цели (сессии или свежей), в ожидание человека или события либо в «стоп». Цели нет — бэклог. */
type Plan = { state: "ready"; target: string | null; term: number | null } | { state: "wait"; term: number | null; human: boolean } | { state: "stop"; why: string };

function plan(def: FactoryDef | null, project: string, s: Pick<Stored, "n" | "dest" | "tag" | "term" | "runs">, k: number): Plan {
  const stop = (why: string): Plan => ({ state: "stop", why });
  const ready = (target: string, term: number): Plan => ({ state: "ready", target, term });
  const dest = s.dest;
  if (!dest) return { state: "ready", target: null, term: s.term };
  const line = def?.lines[dest];
  if (line) {
    const step = line.steps[k];
    if (!step) return stop(`шага ${k + 1} у конвейера ${dest} нет`);
    const runs = runsOf(s);
    const term = (own?: string) => termMs(step.for ?? own ?? line.for!);
    // шаг уже шёл — возврат ведёт та же сессия
    if (runs[k]) return ready(runs[k]!.s, term(def!.posts[sessionName(runs[k]!.s)]?.for));
    if (step.human) return { state: "wait", term: step.for ? termMs(step.for) : null, human: true };
    if (step.wait) return { state: "wait", term: termMs(step.for!), human: false };
    if (step.post) {
      const name = fill(step.post, idOf(project, s.n), s.tag);
      const post = def!.posts[name];
      return post ? ready(`${name}@${post.at.slice(1)}`, term(post.for)) : stop(`поста ${name} нет в определении`);
    }
    if (step.session === "same") {
      for (let j = k - 1; j >= 0; j--) if (runs[j]) return ready(runs[j]!.s, term(def!.posts[sessionName(runs[j]!.s)]?.for));
      return stop(`шагу «${step.name}» не с кого продолжать: до него нет шага с сессией`);
    }
    return ready(FRESH, term());
  }
  const post = def?.posts[dest];
  if (post) return ready(`${dest}@${post.at.slice(1)}`, termMs(post.for));
  if (kindOf(dest) === "session") return s.term ? ready(dest, s.term) : stop("тикету сессии нужен срок работы: for");
  return stop(`исполнителя ${dest} нет: ни конвейера, ни поста, ни сессии`);
}

/** Правка записи тикета по плану шага. */
function planSets(p: Plan, k: number, now: number): { sets: string; params: (string | number | null)[] } {
  if (p.state === "ready") return { sets: "state = 'ready', step = ?, target = ?, term = ?, session = NULL, until = NULL, why = NULL", params: [k, p.target, p.term] };
  if (p.state === "wait") return { sets: "state = 'wait', step = ?, target = NULL, session = NULL, until = ?, why = NULL", params: [k, p.term ? now + p.term : null] };
  return { sets: "state = 'stop', step = ?, until = NULL, why = ?", params: [k, p.why] };
}

/** Шаг, на который возвращают: ближайший прежний шаг с сессией; такого нет — этот же. */
function backTo(def: FactoryDef | null, s: Stored): number {
  const line = s.dest ? def?.lines[s.dest] : undefined;
  if (line) for (let j = s.step - 1; j >= 0; j--) if (!line.steps[j]!.human && !line.steps[j]!.wait) return j;
  return s.step;
}

/* ===== Работа ===== */

/** Текст шага для сессии: что сделать, сданное на прошлом шаге, замечание возврата, последняя заметка без вердикта (повторная находка, слово человека) и чем шаг кончается. */
function body(id: string, s: Stored, def: FactoryDef | null, last: { done?: string; back?: string; note?: string }): string {
  const at = stepOf(def, s);
  return [
    `Тикет ${id}: ${s.title}`,
    ...(at ? [`Шаг «${at.step.name}» конвейера «${at.line.title ?? s.dest}».`] : []),
    ...(at?.step.do ? ["", fill(at.step.do, id, s.tag)] : []),
    ...(s.text ? ["", fill(s.text, id, s.tag)] : []),
    ...(last.done ? ["", `Сдано на прошлом шаге: ${last.done}`] : []),
    ...(last.back ? ["", `Вернули с замечанием: ${last.back}`] : []),
    ...(last.note ? ["", `Последняя заметка к тикету: ${last.note}`] : []),
    "",
    `Шаг кончается вердиктом — инструмент ticket_set: {"ticket":"${id}","verdict":"done","note":"что сделано"}. Вернуть с замечанием — verdict "back"; нужен человек — verdict "stop" с вопросом в note.`,
  ].join("\n");
}

/** Тикет в «стоп» с причиной — если он ещё в том состоянии, из которого его ставят. */
async function stop(env: Env, w: Outside, fleet: string, project: string, n: number, from: TicketState, why: string, by: string, def: FactoryDef | null, now = Date.now()): Promise<Stored | null> {
  const got = await db(env, fleet, project).batch([
    ["UPDATE tickets SET state = 'stop', why = ?1, moved = ?2, until = NULL WHERE n = ?3 AND state = ?4 RETURNING *", why, now, n, from],
    ["INSERT INTO notes (n, at, by, verdict, text) SELECT ?1, ?2, ?3, 'stop', ?4 WHERE changes() > 0", n, now, by, why],
  ]);
  const s = (got[0]![0] as unknown as Stored | undefined) ?? null;
  if (!s) return null;
  await trail(env, w, fleet, project, s, "stop", by, why);
  await call(env, w, fleet, def, `Тикет ${idOf(project, n)} встал`, `${s.title} — ${why}`);
  return s;
}

/** Отдать взятый тикет сессии: свежей — выбрать машину и имя; запрос «дать работу» машине и срок шага на часах. Машина отказала — «стоп» с её словами. */
async function give(env: Env, w: Outside, fleet: string, project: string, def: FactoryDef | null, s: Stored, trace: string): Promise<void> {
  const id = idOf(project, s.n);
  const d = db(env, fleet, project);
  const at = stepOf(def, s);
  const runs = runsOf(s);
  let session = s.session;
  let fresh = runs[s.step]?.fresh ?? false;
  if (!session) {
    // свежая сессия: машина из списка конвейера, где у проекта сейчас идёт меньше шагов; имя — по тикету и шагу
    const busy = await d.all<{ session: string }>("SELECT session FROM tickets WHERE state = 'work' AND session IS NOT NULL");
    const load = (m: string) => busy.filter((b) => machineOf(b.session) === m).length;
    const machine = at!.line.at.map((a) => a.slice(1)).sort((a, b) => load(a) - load(b))[0]!;
    session = `${project}-${s.n}-s${s.step + 1}@${machine}`;
    fresh = true;
  }
  const name = sessionName(session);
  const post = def?.posts[name];
  // документ сессии: свежей — из конвейера и шага; посту — из определения (сессии нет — машина откроет её); сессии вне определения — без документа
  const doc = (o: { cwd: string; key?: string; model?: string; pieces?: string[]; title?: string }): Spec =>
    ({ name, cwd: o.cwd, project, ...(o.key ? { key: o.key } : {}), ...(o.model ? { model: o.model } : {}), ...(o.pieces ? { pieces: o.pieces } : {}), ...(o.title ? { title: o.title } : {}) }) as Spec;
  const spec = fresh && at
    ? doc({ cwd: fill(at.line.cwd, id, s.tag), key: at.step.key ?? at.line.key, model: at.step.model ?? at.line.model, pieces: at.step.pieces ?? at.line.pieces, title: `${s.title} · ${at.step.name}` })
    : post && session === `${name}@${post.at.slice(1)}` ? doc(post) : undefined;
  runs[s.step] = { s: session, ...(fresh ? { fresh: true as const } : {}) };
  await d.run("UPDATE tickets SET session = ?, runs = ? WHERE n = ? AND state = 'work'", session, JSON.stringify(runs), s.n);
  const now_ = { ...s, session, runs: JSON.stringify(runs) };
  const notes = await d.batch([
    ["SELECT text FROM notes WHERE n = ? AND verdict = 'done' AND text <> '' ORDER BY at DESC LIMIT 1", s.n],
    ["SELECT text FROM notes WHERE n = ? AND verdict = 'back' ORDER BY at DESC LIMIT 1", s.n],
    // заметка без вердикта, которой прошлый шаг ещё не видел: она пришла после последнего вердикта
    ["SELECT text FROM notes WHERE n = ?1 AND verdict IS NULL AND at >= (SELECT coalesce(max(at), 0) FROM notes WHERE n = ?1 AND verdict IS NOT NULL) ORDER BY at DESC LIMIT 1", s.n],
  ]);
  const text = (k: number) => (notes[k]![0] as { text?: string } | undefined)?.text;
  const last = { done: text(0), back: s.returns ? text(1) : undefined, note: text(2) };
  const r = await toMachine(w, fleet, trace, {
    type: "work.give", to: "@" + machineOf(session), name, ticket: id, text: body(id, now_, def, last),
    ...(spec ? { spec } : {}), ...(at ? { step: at.step.name } : {}), ...(s.rule ? { on: s.rule } : {}), ...(s.key ? { key: s.key } : {}), ...(s.files ? { files: JSON.parse(s.files) as FileIn[] } : {}),
  });
  if (!r.ok) return void (await stop(env, w, fleet, project, s.n, "work", `работа не дана: ${r.why}`, FACTORY, def));
  await set(env, fleet, { id: timer(project, s.n), kind: TERM, at: s.until!, input: { project, n: s.n, step: s.step } });
  await trail(env, w, fleet, project, now_, "given", FACTORY);
}

/** Раздать готовое. Место берётся одной записью — два одновременных события не запустят тикет дважды. На конвейере место даёт его потолок
 *  и потолок проекта; у сессии — посту или сессии по позывному — один тикет в работе. Проект на паузе — новых шагов нет. */
export async function run(env: Env, w: Outside, fleet: string, project: string, trace: string, now = Date.now()): Promise<void> {
  const a = await applied(env, fleet, project);
  if (a?.row.paused) return;
  const def = a?.def ?? null;
  const lines = Object.entries(def?.lines ?? {});
  const names = lines.map(([name]) => name);
  const marks = names.map(() => "?").join(", ");
  const free = "(t.start IS NULL OR t.start <= ?1) AND (t.target = '*' OR NOT EXISTS (SELECT 1 FROM tickets b WHERE b.state = 'work' AND b.session = t.target))";
  const ops: Op[] = lines.map(([name, line]) => [
    `UPDATE tickets SET state = 'work', moved = ?1, until = ?1 + term, session = CASE WHEN target = '*' THEN NULL ELSE target END WHERE n IN (
       SELECT n FROM (
         SELECT n, row_number() OVER (ORDER BY rank, n) AS pos FROM (
           SELECT t.n, t.rank, row_number() OVER (PARTITION BY CASE WHEN t.target = '*' THEN 'fresh ' || t.n ELSE t.target END ORDER BY t.rank, t.n) AS same
           FROM tickets t WHERE t.state = 'ready' AND t.dest = ?2 AND t.target IS NOT NULL AND ${free}
         ) WHERE same = 1
       ) WHERE pos <= min(?3 - (SELECT count(*) FROM tickets WHERE state = 'work' AND dest = ?2), ?4 - (SELECT count(*) FROM tickets WHERE state = 'work' AND dest IN (${marks})))
     ) RETURNING *`,
    now, name, line.limit, def!.limit, ...names,
  ]);
  // посту и сессии по позывному — по одному тикету, без потолков
  ops.push([
    `UPDATE tickets SET state = 'work', moved = ?1, until = ?1 + term, session = target WHERE n IN (
       SELECT n FROM (
         SELECT t.n, row_number() OVER (PARTITION BY t.target ORDER BY t.rank, t.n) AS same
         FROM tickets t WHERE t.state = 'ready' AND t.target IS NOT NULL AND t.target <> '*' ${names.length ? `AND t.dest NOT IN (${marks})` : ""} AND ${free}
       ) WHERE same = 1
     ) RETURNING *`,
    now, ...names,
  ]);
  const taken = (await db(env, fleet, project).batch(ops)).flat() as unknown as Stored[];
  // свежим сессиям машины выбираются по очереди: вторая видит выбор первой
  for (const s of taken.filter((t) => !t.session)) await give(env, w, fleet, project, def, s, trace);
  await Promise.all(taken.filter((t) => t.session).map((s) => give(env, w, fleet, project, def, s, trace)));
}

/** Тикет закрыт: свежие сессии его шагов убираются — после своего хода; посты и сессии вне тикета остаются. */
async function sweep(w: Outside, fleet: string, s: Stored, trace: string): Promise<void> {
  for (const callsign of new Set(Object.values(runsOf(s)).filter((r) => r.fresh).map((r) => r.s))) {
    const r = await toMachine(w, fleet, trace, { type: "session.remove", to: callsign, after_turn: true });
    if (!r.ok) w.log.warn("сессия шага не убрана", { module: NAME, fleet, callsign, why: r.why });
  }
}

/** После движения тикета: срок на часах, свежие сессии закрытого, зов человека, строка истории и раздача готового. */
async function settle(env: Env, w: Outside, fleet: string, project: string, def: FactoryDef | null, was: Stored | null, s: Stored, move: string, by: string, note: string, trace: string): Promise<void> {
  const id = idOf(project, s.n);
  if (was && (was.state === "work" || was.state === "wait") && (s.state !== was.state || s.step !== was.step)) await drop(env, fleet, { id: timer(project, s.n) });
  if (s.state === "wait" && s.until && (was?.state !== "wait" || was.step !== s.step)) await set(env, fleet, { id: timer(project, s.n), kind: TERM, at: s.until, input: { project, n: s.n, step: s.step } });
  await trail(env, w, fleet, project, s, move, by, note);
  if (s.state === "done") await sweep(w, fleet, s, trace);
  if (s.state === "wait" && stepOf(def, s)?.step.human && (was?.state !== "wait" || was.step !== s.step)) await call(env, w, fleet, def, `Тикет ${id} ждёт вас`, `${s.title} · шаг «${stepOf(def, s)!.step.name}»`);
  if (s.state === "stop" && was?.state !== "stop") await call(env, w, fleet, def, `Тикет ${id} встал`, `${s.title} — ${s.why ?? ""}`);
  await run(env, w, fleet, project, trace);
}

// срок шага вышел, а вердикта нет: «стоп»; тикет уже ушёл с этого шага — срок не про него. Свежая сессия шага останавливается, пост — нет
on(TERM, async (env, fleet, input, w) => {
  const { project, n, step } = input as { project: string; n: number; step: number };
  const got = await db(env, fleet, project).first<Stored>("SELECT * FROM tickets WHERE n = ? AND state IN ('work', 'wait') AND step = ? AND until <= ?", n, step, w.now);
  if (!got) return;
  const def = (await applied(env, fleet, project))?.def ?? null;
  const s = await stop(env, w, fleet, project, n, got.state, "срок вышел", FACTORY, def, w.now);
  if (!s) return;
  const trace = newId("t");
  const ran = runsOf(s)[s.step];
  if (got.state === "work" && ran?.fresh) {
    const r = await toMachine(w, fleet, trace, { type: "session.stop", to: ran.s });
    if (!r.ok) w.log.warn("сессия шага не остановлена", { module: NAME, fleet, callsign: ran.s, why: r.why });
  }
  await run(env, w, fleet, project, trace, w.now);
});

const outside = (ctx: Ctx): Outside => ({ platform: ctx.platform, fetch: ctx.fetch, log: ctx.log });

/* ===== Новый тикет и правила входа ===== */

type Draft = { title: string; text: string; to: string | null; by: string; key?: string; tag?: string; rule?: string; term: number | null; start?: number; files?: FileIn[] };

/** Завести тикет: запись и её место на первом шаге — одной пачкой, тикет не виден «в очереди» раньше, чем узнал свою цель.
 *  Отложенному — разовое правило часов на его момент. Исполнителю негде встать — отказ. */
async function create(env: Env, fleet: string, project: string, def: FactoryDef | null, t: Draft, now: number): Promise<Stored> {
  const p = plan(def, project, { n: 0, dest: t.to, tag: t.tag ?? null, term: t.term, runs: "{}" }, 0);
  if (p.state === "stop") throw new Refusal("no_dest", p.why);
  const { sets, params } = planSets(p, 0, now);
  const got = await db(env, fleet, project).batch([
    [
      "INSERT INTO tickets (title, text, dest, state, by, key, tag, rule, since, moved, term, start, files) VALUES (?, ?, ?, 'ready', ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      t.title, t.text, t.to, t.by, t.key ?? null, t.tag ?? null, t.rule ?? null, now, now, t.term, t.start ?? null, t.files?.length ? JSON.stringify(t.files) : null,
    ],
    [`UPDATE tickets SET ${sets} WHERE n = last_insert_rowid() RETURNING *`, ...params],
  ]);
  const made = got[1]![0] as unknown as Stored;
  if (t.start) await set(env, fleet, { id: `${NAME}/${project}/start/${made.n}`, kind: START, at: t.start, input: { project } });
  return made;
}

// отложенный тикет дождался: раздача готового возьмёт его, если есть место
on(START, async (env, fleet, input, w) => run(env, w, fleet, (input as { project: string }).project, newId("t"), w.now));

/** Откуда событие правила входа: срок часов, зов по имени или запрос на адрес с секретом. */
type Source = "time" | "name" | "hook";
/** Что принесло событие: ключ (нет — ключ правила или его имя), текст, файлы и кто его прислал. */
type Found = { key?: string; text: string; files?: FileIn[]; by: string };

/** Строка истории «rule»: исход одного срабатывания правила входа. */
const ruleLine = (env: Env, w: Outside, fleet: string, project: string, rule: string, source: Source, outcome: string, o: { machine?: string; text?: string; data?: Record<string, unknown> } = {}) =>
  history(env, w, fleet, { msg: "rule", kind: outcome, who: o.machine, text: o.text, data: { project, rule, source, ...o.data } });

/** Событие правила входа: открытый тикет с тем же правилом и ключом получает его заметкой, а файлы — к своим; иначе — новый тикет исполнителю правила. */
async function found(env: Env, w: Outside, fleet: string, project: string, def: FactoryDef, rule: RuleDef, f: Found, trace: string, now: number): Promise<{ id: string; note: boolean }> {
  const key = f.key ?? rule.key ?? rule.name;
  const d = db(env, fleet, project);
  const open = await d.all<{ n: number }>(
    "INSERT INTO notes (n, at, by, verdict, text) SELECT n, ?, ?, NULL, ? FROM tickets WHERE rule = ? AND key = ? AND state <> 'done' ORDER BY n DESC LIMIT 1 RETURNING n",
    now, f.by, f.text || `событие правила «${rule.name}»`, rule.name, key,
  );
  if (open[0]) {
    if (f.files?.length) {
      const had = await d.first<{ files: string | null }>("SELECT files FROM tickets WHERE n = ?", open[0].n);
      await d.run("UPDATE tickets SET files = ? WHERE n = ?", JSON.stringify([...(had?.files ? (JSON.parse(had.files) as FileIn[]) : []), ...f.files]), open[0].n);
    }
    return { id: idOf(project, open[0].n), note: true };
  }
  const made = await create(env, fleet, project, def, { title: rule.title ?? rule.name, text: [rule.text, f.text].filter(Boolean).join("\n\n"), to: rule.to, by: f.by, key, rule: rule.name, term: null, files: f.files }, now);
  await settle(env, w, fleet, project, def, null, made, "new", f.by, made.title, trace);
  return { id: idOf(project, made.n), note: false };
}

/** Событие правила входа по его имени — зов ticket.new {on} и запрос на адрес с секретом. Правила нет — отказ no_rule. Проект на паузе событие
 *  не теряет: тикет встаёт в очередь и ждёт снятия паузы. */
export async function event(env: Env, w: Outside, fleet: string, e: Found & { project: string; rule: string; source: Source; trace: string }): Promise<{ id: string; note: boolean }> {
  const a = await applied(env, fleet, e.project);
  const rule = a?.def.on.find((r) => r.name === e.rule);
  if (!a || !rule) throw new Refusal("no_rule", `правила входа ${e.rule} у проекта ${e.project} нет${a ? `: есть ${a.def.on.map((r) => r.name).join(", ") || "ни одного"}` : ": определение не применено"}`);
  const f = await found(env, w, fleet, e.project, a.def, rule, e, e.trace, Date.now());
  await ruleLine(env, w, fleet, e.project, rule.name, e.source, f.note ? "note" : "ticket", { text: e.text, data: { ticket: f.id, by: e.by } });
  return f;
}

/** Правило входа с адресом: пришедший — участник проекта, правило есть и у него hook. Ответ — проект. Спрашивают «Входы» перед выдачей адреса. */
export async function hookable(ctx: Ctx, named: string | undefined, rule: string): Promise<string> {
  const project = await projectOf(ctx, named);
  const def = (await applied(ctx.env, ctx.fleet, project))?.def;
  if (!def?.on.some((r) => r.name === rule && r.hook)) throw new Refusal("no_rule", `правила входа ${rule} с адресом (hook: true) у проекта ${project} нет`);
  return project;
}

// срок правила входа: проект на паузе — пропуск; проверка вернула 0 — тихо, ни тикета, ни хода модели; иначе её вывод — находка.
// Правило без проверки — находка каждый срок. Исход каждого срабатывания — строка истории «rule».
on(RULE, async (env, fleet, input, w) => {
  const { project, rule: name } = input as { project: string; rule: string };
  const a = await applied(env, fleet, project);
  const rule = a?.def.on.find((r) => r.name === name);
  if (!a || !rule) return w.log.warn("правила входа нет в определении", { module: NAME, fleet, project, rule: name });
  const line = (outcome: string, data: Record<string, unknown> = {}, text = "") => ruleLine(env, w, fleet, project, name, "time", outcome, { machine: rule.check?.at, text, data });
  if (a.row.paused) return line("paused");
  const trace = newId("t");
  let out = "";
  let ran: Record<string, unknown> = {};
  if (rule.check) {
    const r = await toMachine(w, fleet, trace, { type: "shell.run", ...checkRun(rule.check, rule.check.at, rule.check.cwd) });
    // машина не ответила или отказала — проверки не было: это не находка, о машине без связи зовёт наблюдение
    if (!r.ok) return line("failed", {}, r.why);
    const got = r.result as { state: string; code?: number; out?: string; ms?: number };
    ran = { ...(got.code !== undefined ? { code: got.code } : {}), ...(got.ms !== undefined ? { ms: got.ms } : {}) };
    const o = checkOutcome(rule.check, got);
    if (o.good) return line("quiet", ran);
    out = o.text;
  }
  const f = await found(env, w, fleet, project, a.def, rule, { text: out, by: FACTORY }, trace, w.now);
  await line(f.note ? "note" : "ticket", { ...ran, ticket: f.id }, out);
});

/** Правила часов проекта — по правилам входа определения: новое и изменённое ставится, снятое убирается; правило с прежним сроком идёт как шло. */
async function schedule(env: Env, fleet: string, project: string, def: FactoryDef, now: number): Promise<void> {
  const base = ruleTimers(project);
  const have = new Map((await timers(env, fleet, base)).map((t) => [t.id.slice(base.length), t]));
  for (const rule of def.on) {
    if (!rule.every && !rule.cron) continue;
    const every = rule.every ? termMs(rule.every) : undefined;
    const old = have.get(rule.name);
    have.delete(rule.name);
    if (old && old.every === every && old.cron === rule.cron && old.tz === rule.tz) continue;
    await set(env, fleet, { id: base + rule.name, kind: RULE, input: { project, rule: rule.name }, ...(every ? { every } : { cron: rule.cron!, ...(rule.tz ? { tz: rule.tz } : {}) }) }, now);
  }
  for (const gone of have.keys()) await drop(env, fleet, { id: base + gone });
}

/* ===== Определение ===== */

/** Файл определения → проверенное определение. Ошибки — все разом, каждая с путём к месту в файле. */
async function check(ctx: Ctx, project: string, text: string): Promise<FactoryDef> {
  const bad = (errors: string[]) => new Refusal("bad_factory", errors.join("; "));
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw bad([`${FACTORY_FILE} — не JSON: ${e instanceof Error ? e.message : e}`]);
  }
  const parsed = FactoryDef.safeParse(raw);
  if (!parsed.success) throw bad(parsed.error.issues.map((i) => `${i.path.join(".") || "файл"}: ${i.message}`));
  const def = parsed.data;
  const errors: string[] = [];
  if (def.project !== project) errors.push(`project: в файле ${def.project}, применяется к ${project}`);
  const repos = (await fleetPref<string[]>(ctx.env, ctx.fleet, REPOS)) ?? [];
  const machines = new Set((await within(ctx.platform.machines(ctx.fleet), CALL_MS, "платформа не назвала машины")).map((m) => m.name));
  const place = (path: string, at: string) => {
    const m = at.slice(1);
    if (!machines.has(m)) errors.push(`${path}: машины ${m} нет во флоте`);
    else if (!canReach(ctx.who, m)) errors.push(`${path}: до машины ${m} вы не достаёте`);
  };
  const roles = (path: string, pieces?: string[]) => {
    for (const p of pieces ?? []) if (!repos.includes(p.split("/").slice(0, 2).join("/"))) errors.push(`${path}: роли ${p} нет в репозиториях флота (${REPOS})`);
  };
  for (const [name, post] of Object.entries(def.posts)) {
    place(`posts.${name}.at`, post.at);
    roles(`posts.${name}.pieces`, post.pieces);
    if (def.lines[name]) errors.push(`posts.${name}: имя занято конвейером`);
  }
  for (const [name, line] of Object.entries(def.lines)) {
    line.at.forEach((at, i) => place(`lines.${name}.at[${i}]`, at));
    roles(`lines.${name}.pieces`, line.pieces);
    line.steps.forEach((step, i) => {
      const path = `lines.${name}.steps[${i}]`;
      const who = [step.session, step.post, step.human, step.wait].filter((x) => x !== undefined).length;
      if (who !== 1) errors.push(`${path}: у шага один исполнитель — session, post, human или wait`);
      const worker = step.session !== undefined || step.post !== undefined;
      if (step.session !== undefined) {
        if (!(step.for ?? line.for)) errors.push(`${path}: у шага сессии нет срока (for) — ни своего, ни у конвейера`);
        if (!(step.key ?? line.key) || !(step.model ?? line.model)) errors.push(`${path}: сессии шага не названы провайдер и модель (key, model) — ни у шага, ни у конвейера`);
        if (step.session === "same" && !line.steps.slice(0, i).some((x) => x.session !== undefined || x.post !== undefined)) errors.push(`${path}: «та же сессия» — до шага нет шага с сессией`);
      }
      if (step.post !== undefined && !step.post.includes("{tag}") && !def.posts[step.post]) errors.push(`${path}: поста ${step.post} нет в posts`);
      if (step.wait !== undefined && !step.for) errors.push(`${path}: у ожидания события нет срока (for)`);
      if (step.check && !worker) errors.push(`${path}: проверка бывает у шага с сессией`);
      if (!worker && (step.key || step.model || step.pieces || step.do)) errors.push(`${path}: do, key, model и pieces бывают у шага с сессией`);
      roles(`${path}.pieces`, step.pieces);
    });
  }
  const names = new Set<string>();
  def.on.forEach((rule, i) => {
    const path = `on[${i}]`;
    if (names.has(rule.name)) errors.push(`${path}.name: правило ${rule.name} уже есть`);
    names.add(rule.name);
    // вход у правила не больше чем один: срок или адрес; без входа правило зовут по имени
    if ([rule.every, rule.cron, rule.hook].filter((x) => x !== undefined).length > 1) errors.push(`${path}: у правила не больше одного входа — every, cron или hook`);
    if (rule.check && rule.every === undefined && rule.cron === undefined) errors.push(`${path}.check: проверка бывает у правила со сроком`);
    if (rule.tz && !rule.cron) errors.push(`${path}.tz: часовой пояс бывает у cron`);
    if (rule.cron)
      try {
        next({ cron: rule.cron, tz: rule.tz }, Date.now());
      } catch (e) {
        errors.push(`${path}.cron: ${e instanceof Refusal ? e.why : e}`);
      }
    if (!def.lines[rule.to] && !def.posts[rule.to]) errors.push(`${path}.to: исполнителя ${rule.to} нет: ни конвейера, ни поста`);
    if (rule.check) {
      place(`${path}.check.at`, rule.check.at);
      if (termMs(rule.check.for) > RULE_CHECK_MS) errors.push(`${path}.check.for: предел проверки правила — не больше ${RULE_CHECK_MS / 1000}s`);
    }
  });
  if (errors.length) throw bad(errors);
  return def;
}

export const factory: Module = {
  name: NAME,
  handlers: {
    async "ticket.new"(i: { project?: string; to?: string; title?: string; text?: string; tag?: string; key?: string; for?: string; in?: string; on?: string; files?: FileIn[] }, ctx) {
      const project = await projectOf(ctx, i.project);
      if (i.on !== undefined) {
        // событие правила входа: исполнитель, название и срок — у правила
        if (i.to !== undefined || i.title !== undefined || i.tag !== undefined || i.for || i.in) throw new Refusal("bad_input", "событие правила входа несёт только on, key, text и files: исполнитель и название — у правила");
        return { id: (await event(ctx.env, outside(ctx), ctx.fleet, { project, rule: i.on, source: "name", key: i.key, text: i.text ?? "", files: i.files, by: ctx.who.addr, trace: ctx.trace })).id };
      }
      if (!i.title) throw new Refusal("bad_input", "тикету нужно название: title");
      const def = (await applied(ctx.env, ctx.fleet, project))?.def ?? null;
      const now = Date.now();
      if (i.to !== undefined && !def?.lines[i.to] && !def?.posts[i.to]) {
        if (kindOf(i.to) !== "session") throw new Refusal("no_dest", `исполнителя ${i.to} нет: ни конвейера, ни поста проекта ${project}; сессии — позывной вида site@laptop`);
        if (!i.for) throw new Refusal("no_term", "тикету сессии нужен срок работы: for — 20m, 2h, 1d");
        if (!(await within(ctx.platform.sessions(ctx.fleet), CALL_MS, "платформа не назвала сессии")).some((s) => s.callsign === i.to)) throw new Refusal("no_session", `сессии ${i.to} нет во флоте`);
      }
      if (i.in && i.to === undefined) throw new Refusal("bad_input", "отложить можно тикет с исполнителем: назовите to");
      const made = await create(
        ctx.env, ctx.fleet, project, def,
        { title: i.title, text: i.text ?? "", to: i.to ?? null, by: ctx.who.addr, key: i.key, tag: i.tag, files: i.files, term: i.for ? termMs(i.for) : null, ...(i.in ? { start: now + termMs(i.in) } : {}) },
        now,
      );
      ctx.after(settle(ctx.env, outside(ctx), ctx.fleet, project, def, null, made, "new", ctx.who.addr, i.title, ctx.trace));
      return { id: idOf(project, made.n) };
    },

    async "ticket.list"(i: { project?: string; ticket?: string; to?: string; state?: TicketState; session?: string }, ctx) {
      const d = (project: string) => db(ctx.env, ctx.fleet, project);
      if (i.ticket) {
        const { project, n } = parse(i.ticket);
        await member(ctx, project);
        const got = await d(project).batch([
          ["SELECT * FROM tickets WHERE n = ?", n],
          ["SELECT at, by, verdict, text FROM notes WHERE n = ? ORDER BY at", n],
        ]);
        const s = got[0]![0] as unknown as Stored | undefined;
        if (!s) throw new Refusal("no_ticket", `тикета ${i.ticket} нет`);
        const notes = (got[1] as unknown as { at: number; by: string; verdict: Verdict | null; text: string }[]).map((x) => ({ at: x.at, by: x.by, text: x.text, ...(x.verdict ? { verdict: x.verdict } : {}) }));
        return { tickets: [ticket(project, s, (await applied(ctx.env, ctx.fleet, project))?.def ?? null, notes)] };
      }
      const project = await projectOf(ctx, i.project);
      const where = ["1 = 1"];
      const params: (string | number)[] = [];
      if (i.state) (where.push("state = ?"), params.push(i.state));
      if (i.to) (where.push("dest = ?"), params.push(i.to));
      if (i.session) (where.push("session = ?"), params.push(i.session));
      const rows = await d(project).all<Stored>(`SELECT * FROM tickets WHERE ${where.join(" AND ")} ORDER BY n DESC LIMIT 500`, ...params);
      const def = (await applied(ctx.env, ctx.fleet, project))?.def ?? null;
      return { tickets: rows.map((s) => ticket(project, s, def)) };
    },

    async "ticket.set"(i: { ticket: string; verdict?: Verdict; note?: string; to?: string; for?: string; resume?: boolean; drop?: boolean; pr?: string }, ctx) {
      const { project, n } = parse(i.ticket);
      await member(ctx, project);
      const d = db(ctx.env, ctx.fleet, project);
      const was = await d.first<Stored>("SELECT * FROM tickets WHERE n = ?", n);
      if (!was) throw new Refusal("no_ticket", `тикета ${i.ticket} нет`);
      if ([i.verdict, i.resume, i.drop].filter(Boolean).length > 1) throw new Refusal("bad_input", "одно из трёх: verdict, resume или drop");
      const def = (await applied(ctx.env, ctx.fleet, project))?.def ?? null;
      const by = ctx.who.addr;
      const now = Date.now();
      const note = i.note ?? "";
      /** Правка тикета, если он всё ещё в том же состоянии и на том же шаге; заметка — той же пачкой. Тикет уже ушёл — отказ. */
      const move = async (sets: string, params: (string | number | null)[], verdict: Verdict | null, text: string): Promise<Stored> => {
        const ops: Op[] = [[`UPDATE tickets SET ${sets}, moved = ? WHERE n = ? AND state = ? AND step = ? RETURNING *`, ...params, now, n, was.state, was.step]];
        if (verdict || text) ops.push(["INSERT INTO notes (n, at, by, verdict, text) SELECT ?, ?, ?, ?, ? WHERE changes() > 0", n, now, by, verdict, text]);
        const s = (await d.batch(ops))[0]![0] as unknown as Stored | undefined;
        if (!s) throw new Refusal("bad_state", `тикет ${i.ticket} уже изменён: прочитайте его заново`);
        return s;
      };
      const planned = (k: number, extra = "", more: (string | number | null)[] = [], verdict: Verdict | null = null, text = note) => {
        const { sets, params } = planSets(plan(def, project, was, k), k, now);
        return move(sets + extra, [...params, ...more], verdict, text);
      };
      let s: Stored;
      let word: string;
      if (i.verdict) {
        // вердикт шагу в работе или ожидании: сессия — только та, что ведёт шаг; машина — шагу своей сессии; человек — любому
        if (was.state !== "work" && was.state !== "wait") throw new Refusal("bad_state", `тикет ${i.ticket} — ${was.state}: вердикт дают шагу в работе или ожидании`);
        const kind = kindOf(by);
        if (kind === "session" && was.session !== by) throw new Refusal("not_yours", `шаг тикета ${i.ticket} ведёт ${was.session ?? "не сессия"}`);
        if (kind === "machine" && machineOf(was.session ?? "") !== machineOf(by)) throw new Refusal("not_yours", `шаг тикета ${i.ticket} ведёт сессия другой машины`);
        const last = (was.dest ? def?.lines[was.dest]?.steps.length : undefined) ?? 1;
        if (i.verdict === "done") {
          const pr = i.pr ? ", pr = ?" : "";
          s = was.step + 1 >= last ? await move("state = 'done', until = NULL, why = NULL, target = NULL" + pr, i.pr ? [i.pr] : [], "done", note) : await planned(was.step + 1, pr, i.pr ? [i.pr] : [], "done");
        } else if (i.verdict === "stop") s = await move("state = 'stop', until = NULL, why = ?", [note || "нужен человек"], "stop", note);
        else {
          // возврат: машина сессии — проверка шага не прошла, шаг остаётся у той же сессии; иначе — назад, на ближайший прежний шаг с сессией
          const k = kind === "machine" ? was.step : backTo(def, was);
          const again = was.backstep === k ? was.returns + 1 : 1;
          if (again >= RETURNS) s = await move("state = 'stop', until = NULL, why = 'второй возврат', returns = ?, backstep = ?", [again, k], "back", note);
          else if (kind === "machine") s = await move("returns = ?, backstep = ?", [again, k], "back", note);
          else s = await planned(k, ", returns = ?, backstep = ?", [again, k], "back");
        }
        word = s.state === "stop" && i.verdict === "back" ? "stop" : i.verdict;
      } else if (i.resume) {
        if (was.state !== "stop") throw new Refusal("bad_state", `тикет ${i.ticket} — ${was.state}: в очередь возвращают вставший`);
        s = await planned(was.step, ", returns = 0, backstep = NULL", [], null, note || "возвращён в очередь");
        word = "resume";
      } else if (i.drop) {
        if (was.state === "done") throw new Refusal("bad_state", `тикет ${i.ticket} уже закрыт`);
        s = await move("state = 'done', until = NULL, target = NULL, dropped = 1", [], null, note || "снят");
        word = "drop";
      } else {
        // правка без вердикта: исполнитель, срок, PR, заметка
        const term = i.for ? termMs(i.for) : was.term;
        if (i.to !== undefined) {
          if (was.state === "work") throw new Refusal("bad_state", `тикет ${i.ticket} в работе: исполнителя меняют у тикета в очереди или вставшего`);
          const p = plan(def, project, { ...was, dest: i.to, term, runs: "{}" }, 0);
          if (p.state === "stop") throw new Refusal(kindOf(i.to) === "session" && !term ? "no_term" : "no_dest", p.why);
          // вставший тикет исполнителя меняет, но в очередь не идёт: его возвращает resume
          const { sets, params } = was.state === "stop" ? { sets: "step = 0, term = ?", params: [p.state === "ready" ? p.term : null] } : planSets(p, 0, now);
          s = await move(`${sets}, dest = ?, runs = '{}'` + (i.pr ? ", pr = ?" : ""), [...params, i.to, ...(i.pr ? [i.pr] : [])], null, note);
          word = "assign";
        } else {
          const sets: string[] = [];
          const params: (string | number | null)[] = [];
          if (i.for) (sets.push("term = ?"), params.push(term));
          if (i.pr) (sets.push("pr = ?"), params.push(i.pr));
          if (!sets.length && !note) throw new Refusal("bad_input", "нечего менять: назовите verdict, resume, drop, to, for, pr или note");
          s = await move(sets.length ? sets.join(", ") : "n = n", params, null, note);
          word = "note";
        }
      }
      ctx.after(settle(ctx.env, outside(ctx), ctx.fleet, project, def, was, s, word, by, note, ctx.trace));
      return { id: i.ticket, state: s.state, step: s.step };
    },

    async "factory.apply"(i: { project: string; repo: string }, ctx) {
      await member(ctx, i.project);
      const w = outside(ctx);
      const refused = (e: Refusal) => history(ctx.env, w, ctx.fleet, { msg: "factory", kind: "refused", who: ctx.who.addr, text: `${e.word}: ${e.why ?? ""}`, data: { project: i.project, repo: i.repo, by: ctx.who.addr } });
      let def: FactoryDef;
      let commit: string;
      try {
        if (!((await fleetPref<string[]>(ctx.env, ctx.fleet, REPOS)) ?? []).includes(i.repo)) throw new Refusal("bad_factory", `репозитория ${i.repo} нет в настройке флота ${REPOS}: роли из него сессии не получат`);
        const got = await file(ctx, i.repo, FACTORY_FILE);
        commit = got.commit;
        def = await check(ctx, i.project, got.text);
      } catch (e) {
        if (e instanceof Refusal) ctx.after(refused(e));
        throw e;
      }
      const d = db(ctx.env, ctx.fleet, i.project);
      await d.run(
        "INSERT INTO def (one, repo, sha, at, by, json) VALUES (1, ?1, ?2, ?3, ?4, ?5) ON CONFLICT (one) DO UPDATE SET repo = ?1, sha = ?2, at = ?3, by = ?4, json = ?5",
        i.repo, commit, Date.now(), ctx.who.addr, JSON.stringify(def),
      );
      // тикеты в очереди узнают цель заново: конвейер или пост могли измениться
      const now = Date.now();
      for (const t of await d.all<Stored>("SELECT * FROM tickets WHERE state = 'ready' AND dest IS NOT NULL")) {
        const { sets, params } = planSets(plan(def, i.project, t, t.step), t.step, now);
        await d.run(`UPDATE tickets SET ${sets} WHERE n = ? AND state = 'ready'`, ...params, t.n);
      }
      await schedule(ctx.env, ctx.fleet, i.project, def, now);
      // посты, которых ещё нет, открываются; не открылся — причина в ответе, пост откроется с первым тикетом
      const have = new Set((await within(ctx.platform.sessions(ctx.fleet), CALL_MS, "платформа не назвала сессии")).map((s) => s.callsign));
      const opened: string[] = [];
      const failed: { post: string; why: string }[] = [];
      for (const [name, post] of Object.entries(def.posts)) {
        const callsign = `${name}@${post.at.slice(1)}`;
        if (have.has(callsign)) continue;
        const r = await toMachine(w, ctx.fleet, ctx.trace, {
          type: "session.open", to: post.at, mkdir: true,
          spec: { name, cwd: post.cwd, key: post.key, model: post.model, project: i.project, ...(post.pieces ? { pieces: post.pieces } : {}), ...(post.title ? { title: post.title } : {}) },
        });
        if (r.ok) opened.push(callsign);
        else failed.push({ post: name, why: r.why });
      }
      ctx.after(history(ctx.env, w, ctx.fleet, { msg: "factory", kind: "applied", who: ctx.who.addr, text: commit, data: { project: i.project, repo: i.repo, commit, by: ctx.who.addr } }).then(() => run(ctx.env, w, ctx.fleet, i.project, ctx.trace)));
      return { commit, posts: Object.keys(def.posts).length, lines: Object.keys(def.lines).length, rules: def.on.length, opened, failed };
    },

    async "factory.get"(i: { project?: string }, ctx) {
      if (!i.project && kindOf(ctx.who.addr) !== "session") {
        // человеку без названного проекта — его проекты, у которых определение применено
        const mine = (await projects(ctx)).filter((p) => ctx.who.admin || p.members.includes(ctx.who.person));
        const rows = await Promise.all(mine.map(async (p) => ({ project: p.id, a: await applied(ctx.env, ctx.fleet, p.id) })));
        return { projects: rows.flatMap(({ project, a }) => (a ? [{ project, repo: a.row.repo, commit: a.row.sha, at: a.row.at, paused: !!a.row.paused }] : [])) };
      }
      const project = await projectOf(ctx, i.project);
      const a = await applied(ctx.env, ctx.fleet, project);
      if (!a) throw new Refusal("no_factory", `у проекта ${project} определения нет: его применяет factory_apply`);
      const counts = await db(ctx.env, ctx.fleet, project).all<{ dest: string; state: string; n: number }>("SELECT dest, state, count(*) AS n FROM tickets WHERE state IN ('work', 'ready') AND dest IS NOT NULL GROUP BY dest, state");
      const of = (dest: string, state: string) => counts.find((c) => c.dest === dest && c.state === state)?.n ?? 0;
      const lines = Object.fromEntries(Object.keys(a.def.lines).map((name) => [name, { work: of(name, "work"), ready: of(name, "ready") }]));
      const base = ruleTimers(project);
      const due = Object.fromEntries((await timers(ctx.env, ctx.fleet, base)).map((t) => [t.id.slice(base.length), t.at]));
      const state: FactoryState = {
        project, repo: a.row.repo, commit: a.row.sha, at: a.row.at, paused: !!a.row.paused, def: a.def,
        load: { work: Object.values(lines).reduce((n, l) => n + l.work, 0), lines }, next: due,
      };
      return { factory: state };
    },

    async "factory.pause"(i: { project?: string; on: boolean }, ctx) {
      const project = await projectOf(ctx, i.project);
      const got = await db(ctx.env, ctx.fleet, project).all("UPDATE def SET paused = ? WHERE one = 1 RETURNING one", i.on ? 1 : 0);
      if (!got.length) throw new Refusal("no_factory", `у проекта ${project} определения нет: его применяет factory_apply`);
      const w = outside(ctx);
      // пауза снята — очередь идёт дальше
      ctx.after(history(ctx.env, w, ctx.fleet, { msg: "factory", kind: i.on ? "paused" : "resumed", who: ctx.who.addr, data: { project, by: ctx.who.addr } }).then(() => (i.on ? undefined : run(ctx.env, w, ctx.fleet, project, ctx.trace))));
      return { paused: i.on };
    },
  },
};
