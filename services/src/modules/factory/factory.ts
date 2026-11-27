// Фабрика: тикеты флота. Тикет — единица работы проекта: исполнитель, состояние и заметки с вердиктами; записи — объект на проект.
// Исполнитель — пост из определения проекта либо сессия по позывному. Пост — очередь роли: тикеты из неё берут его сессии,
// свободная — срочный, потом старший; тикет, который сессия уже вела (возврат, проснувшийся), ждёт её. У поста своё правило разговора
// (context): на границе тикетов разговор сессии продолжается или начинается заново — по предмету тикета (key). Пост «по предмету» отдаёт
// тикеты одного предмета одной сессии по очереди. Работу посту с раздающими (givers) дают только их сессии. Определение — файл factory.json
// в репозитории ролей, применяется явным вызовом; битое не применяется. Тикет отдаётся сессии запросом «дать работу» её машине; кончает
// работу вердикт — сессии, которая его ведёт, машины этой сессии или человека — либо срок. Тикеты заводят и правила входа из определения:
// по сроку правила идёт проверка-скрипт на машине, код 0 — тихо, иначе её вывод — находка: новый тикет или заметка в открытый с тем же
// ключом. Тем же событием правила приходит зов по имени (ticket.new {on}) и запрос на адрес с секретом (модуль «Входы»).
// Сессия, которая ведёт тикет, может усыпить его (место свободно) и передать другому исполнителю. Спящий тикет ждёт события, которое
// назвал: итога каждого названного тикета (сдан, снят или встал) или своего срока — будит первое; ещё его будит resume. Заметка не будит:
// она доходит до сессии при выдаче и отказом перед «сдал». Итог тикета ложится одной заметкой в тикет, с которого он заведён, и в тикеты,
// которые его ждут.
// Сама Фабрика ничего не чинит и не повторяет: отказ машины, второй возврат и вышедший срок ставят тикет в «стоп» с причиной.
// «Стоп», который поставила платформа (служба или машина), идёт событием правила stop — тикетом посту-надзирателю; один раз на тикет.
// «Стоп» по слову сессии или человека, повторный «стоп» и «стоп» тикета самого надзирателя зовут людей проекта.
import {
  CALL_MS, canReach, checkOutcome, checkRun, errFields, FACTORY, FACTORY_FILE, FactoryDef, type FactoryState, type FileIn, kindOf, MACHINE_RULES, machineOf, newId, type PostDef, postOf, postSessions, type Project, Refusal,
  RULE_CHECK_MS, type RuleDef, sessionName, type Spec, splitPiece, termMs, type Ticket, type TicketAct, type TicketNote, type TicketState, type Verdict, within,
} from "@sb/protocol";
import type { Ctx, Env, Module, Outside } from "../../env.ts";
import { type Db, type Op, records } from "../../records.ts";
import { line as historyLine } from "../analytics/contract.ts";
import { drop, list as timers, next, on, set } from "../clock/contract.ts";
import { file } from "../github/contract.ts";
import { fleetPref } from "../prefs/contract.ts";
import { sendTo } from "../reach/contract.ts";

const NAME = "factory";
/** Вид правила часов: срок тикета в работе. */
const TERM = "factory.term";
/** Вид правила часов: срок правила входа по времени. */
const RULE = "factory.rule";
/** Вид правила часов: спящий тикет дождался своего срока. */
const START = "factory.start";
/** Возвратов тикету: второй ставит его в «стоп». */
const RETURNS = 2;
/** Место срочного тикета в очереди: впереди обычных (у них 0). */
const FIRST = -1;
/** Сколько знаков заметок идёт сессии разом — вместе с тикетом и в отказе перед «сдал»; что не вошло, читается ticket_list. */
const NOTES_OUT = 4000;
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
  // тикет → тикет, с которого он заведён: итог ляжет туда заметкой
  "CREATE TABLE IF NOT EXISTS parents (n INTEGER PRIMARY KEY, parent INTEGER NOT NULL)",
  // спящий тикет → тикет, итога которого он ждёт: строка уходит с итогом; строк не осталось — тикет просыпается
  "CREATE TABLE IF NOT EXISTS waits (n INTEGER NOT NULL, blocker INTEGER NOT NULL, PRIMARY KEY (n, blocker))",
  "CREATE INDEX IF NOT EXISTS waits_blocker ON waits (blocker)",
  // о чём разговор сессии поста: последний выданный ей тикет и его предмет — по ним решается «заново» и свой предмет в очереди
  "CREATE TABLE IF NOT EXISTS talks (session TEXT PRIMARY KEY, n INTEGER NOT NULL, key TEXT)",
];
const db = (env: Env, fleet: string, project: string) => records(env, fleet, NAME, SCHEMA, project);

/** Сессия, которая вела тикет: seen — номер последней заметки, которую она получила. */
type Run = { s: string; seen?: number };
type Stored = {
  n: number; title: string; text: string; dest: string | null; step: number; state: TicketState; session: string | null; target: string | null; runs: string;
  by: string; why: string | null; key: string | null; rule: string | null; returns: number;
  since: number; moved: number; term: number | null; until: number | null; start: number | null; rank: number; dropped: number; files: string | null;
  /** тикет, с которого этот заведён, и тикеты, которых он ждёт (номера через запятую), — у строки, прочитанной вместе с ними */
  parent?: number | null; waits?: string | null;
};
type Applied = { repo: string; sha: string; at: number; paused: number; json: string };
/** Чтение тикета вместе с тем, с кого он заведён и кого ждёт. */
const WITH = "t.*, p.parent, (SELECT group_concat(w.blocker) FROM waits w WHERE w.n = t.n) AS waits FROM tickets t LEFT JOIN parents p ON p.n = t.n";
/** То же без текста — строка списка. */
const ROW = WITH.replace("t.*", "t.n, t.title, '' AS text, t.dest, t.state, t.session, t.by, t.why, t.key, t.rule, t.returns, t.since, t.moved, t.until, t.start, t.rank, t.dropped");

const idOf = (project: string, n: number) => `${project}-${n}`;
/** Номер тикета → проект и порядковое число. */
function parse(id: string): { project: string; n: number } {
  const cut = id.lastIndexOf("-");
  const n = Number(id.slice(cut + 1));
  if (cut < 1 || !Number.isInteger(n) || n < 1) throw new Refusal("no_ticket", `${id} — не номер тикета: номер вида проект-число`);
  return { project: id.slice(0, cut), n };
}
const timer = (project: string, n: number) => `${NAME}/${project}/${n}`;
/** Имя разового правила часов: спящий тикет дождался своего срока. */
const startTimer = (project: string, n: number) => `${NAME}/${project}/start/${n}`;
/** Имена правил часов у правил входа проекта: начало общее, чтобы прочитать и снять их разом. */
const ruleTimers = (project: string) => `${NAME}/${project}/on/`;
const runOf = (s: Pick<Stored, "runs">): Run | undefined => (JSON.parse(s.runs) as Record<string, Run>)[0];
const runs = (r: Run) => JSON.stringify({ 0: r });
/** Подстановка определения: {id} — номер тикета. */
const fill = (text: string, id: string) => text.replaceAll("{id}", id);

/** Применённое определение проекта; нет — null. */
async function applied(env: Env, fleet: string, project: string): Promise<{ def: FactoryDef; row: Applied } | null> {
  const row = await db(env, fleet, project).first<Applied>("SELECT repo, sha, at, paused, json FROM def WHERE one = 1");
  return row ? { def: JSON.parse(row.json) as FactoryDef, row } : null;
}

/** Номера вставших тикетов, которыми занят надзиратель: их называют ключом открытые тикеты правила stop. */
const watched = async (d: Db): Promise<Set<string>> =>
  new Set((await d.all<{ key: string }>("SELECT key FROM tickets WHERE rule = ? AND state <> 'done'", MACHINE_RULES.stop)).map((x) => x.key));

/** Тикет глазами спросившего. Строка списка — без текста, файлов и заметок: их несёт тикет, названный по номеру (full).
 *  busy — вставшие тикеты у надзирателя: остальные вставшие ждут человека. */
const ticket = (project: string, s: Stored, def: FactoryDef | null, busy: Set<string>, full?: { notes: TicketNote[] }): Ticket => {
  const id = idOf(project, s.n);
  const check = s.state === "work" && s.dest ? def?.posts?.[s.dest]?.check : undefined;
  return {
    id, project, title: s.title, state: s.state, by: s.by, returns: s.returns, since: s.since, moved: s.moved,
    ...(s.dest ? { to: s.dest } : {}), ...(s.session ? { session: s.session } : {}), ...(s.why ? { why: s.why } : {}), ...(s.key ? { key: s.key } : {}),
    ...(s.state === "stop" && !busy.has(id) ? { human: true } : {}),
    ...(s.rule ? { on: s.rule } : {}), ...(s.start ? { start: s.start } : {}), ...(s.until ? { until: s.until } : {}), ...(s.dropped ? { dropped: true } : {}),
    ...(s.rank < 0 ? { first: true } : {}), ...(s.waits ? { after: String(s.waits).split(",").map((n) => idOf(project, Number(n))) } : {}),
    ...(check ? { check: { ...check, run: fill(check.run, id) } } : {}), ...(s.parent ? { parent: idOf(project, s.parent) } : {}),
    ...(full ? { text: s.text, notes: full.notes, ...(s.files ? { files: JSON.parse(s.files) as FileIn[] } : {}) } : {}),
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

/** Строка истории флота: движение тикета или событие определения. Машина — та, где сессия тикета или исполнитель. Не записалась — строка журнала службы. */
function history(env: Env, w: Outside, fleet: string, l: { msg: string; kind: string; who?: string; text?: string; data: Record<string, unknown> }): Promise<void> {
  const who = l.who ?? "";
  return historyLine(env, w.fetch, fleet, { file: NAME, msg: l.msg, kind: l.kind, machine: machineOf(who) ?? "", session: kindOf(who) === "session" ? who : "", text: (l.text ?? "").slice(0, 500), data: l.data })
    .catch((e: unknown) => w.log.warn("строка истории фабрики не записалась", { module: NAME, fleet, ...errFields(e) }));
}
const trail = (env: Env, w: Outside, fleet: string, project: string, s: Stored, move: string, by: string, text = "", more: Record<string, unknown> = {}) =>
  history(env, w, fleet, { msg: "ticket", kind: move, who: s.session ?? (kindOf(s.dest ?? "") === "session" ? s.dest! : by), text, data: { ticket: idOf(project, s.n), project, state: s.state, by, ...(s.dest ? { to: s.dest } : {}), ...more } });

/** Позвать людей проекта: тикет встал. Не ушло — строка журнала. */
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

/* ===== Кто ведёт тикет ===== */

/** Пост исполнителя: сам пост либо пост, которому принадлежит сессия; исполнитель вне постов — undefined. */
const doer = (def: FactoryDef | null, to: string | null | undefined): { name: string; post: PostDef } | undefined =>
  !def || !to ? undefined : def.posts[to] ? { name: to, post: def.posts[to]! } : postOf(def.posts, to);

/** Почему пришедший не вправе дать работу исполнителю to; вправе — null. У поста с раздающими работу другому дают только их сессии;
 *  тикет самой себе, службы флота, правила определения и человек проходят. */
function ungiven(def: FactoryDef | null, by: string, to: string | null | undefined): Refusal | null {
  if (kindOf(by) !== "session" || by === to) return null;
  const dest = doer(def, to);
  if (!dest?.post.givers) return null;
  const from = postOf(def!.posts, by)?.name;
  return from && dest.post.givers.includes(from) ? null : new Refusal("not_giver", `посту ${dest.name} работу раздают ${dest.post.givers.join(", ")}: отдай находку им`);
}

/** Куда встаёт тикет: в очередь к цели (посту или сессии) либо в «стоп». Цели нет — бэклог. */
type Plan = { state: "ready"; target: string | null; term: number | null } | { state: "stop"; why: string };

function plan(def: FactoryDef | null, s: Pick<Stored, "dest" | "term" | "runs">): Plan {
  const dest = s.dest;
  if (!dest) return { state: "ready", target: null, term: s.term };
  // пост — очередь роли: новый тикет ждёт любую его сессию; тот, который сессия поста уже вела (возврат, проснувшийся), — её
  const post = def?.posts?.[dest];
  if (post) return { state: "ready", target: runOf(s)?.s ?? dest, term: termMs(post.for) };
  if (kindOf(dest) === "session") return s.term ? { state: "ready", target: dest, term: s.term } : { state: "stop", why: "тикету сессии нужен срок работы: for" };
  return { state: "stop", why: `исполнителя ${dest} нет: ни поста, ни сессии` };
}

/** Правка записи тикета по плану. */
function planSets(p: Plan): { sets: string; params: (string | number | null)[] } {
  if (p.state === "ready") return { sets: "state = 'ready', target = ?, term = ?, session = NULL, until = NULL, why = NULL", params: [p.target, p.term] };
  return { sets: "state = 'stop', until = NULL, why = ?", params: [p.why] };
}

/* ===== Работа ===== */

/** Заметка, которую сессия ещё не получала: её номер в записях, от кого и текст. */
type Fresh = { rowid: number; by: string; text: string };
/** Заметки сессии одним куском, по порядку прихода. В предел знаков идут свежие; что не вошло, называется числом — читается ticket_list. */
function pack(id: string, notes: Fresh[]): string {
  const lines: string[] = [];
  let left = NOTES_OUT;
  for (const x of [...notes].reverse()) {
    const line = `— ${x.by}: ${x.text}`;
    if (lines.length && line.length > left) break;
    lines.unshift(line.slice(0, NOTES_OUT));
    left -= line.length;
  }
  const more = notes.length - lines.length;
  return [`Заметки к тикету (${notes.length}):`, ...(more ? [`— ещё ${more} раньше: ticket_list {"ticket":"${id}"}`] : []), ...lines].join("\n");
}

/** Разбудить спящий тикет: он встаёт в очередь к своей цели, названные ожидания и срок сняты. Будят итог названных тикетов, срок и resume —
 *  заметка не будит. Ответ — проснулся ли: раздать готовое должен тот, кто звал. */
async function wake(env: Env, w: Outside, fleet: string, project: string, n: number, by: string, now: number, from?: string): Promise<boolean> {
  const d = db(env, fleet, project);
  const got = await d.batch([
    ["SELECT moved FROM tickets WHERE n = ? AND state = 'wait'", n],
    ["UPDATE tickets SET state = 'ready', start = NULL, moved = ? WHERE n = ? AND state = 'wait' RETURNING *", now, n],
    ["DELETE FROM waits WHERE n = ?", n],
  ]);
  const s = got[1]![0] as unknown as Stored | undefined;
  if (!s) return false;
  await drop(env, fleet, { id: startTimer(project, n) });
  await trail(env, w, fleet, project, s, "wake", by, "", { waited_ms: now - ((got[0]![0] as { moved: number } | undefined)?.moved ?? now), ...(from ? { from } : {}) });
  return true;
}

/** Итог тикета — тем, кому он нужен: тикету, с которого этот заведён, и тикетам, которые его ждут; каждому — одна заметка. Ждущий,
 *  у которого итог есть у всех названных, просыпается. Ответ — проснулся ли кто-нибудь. */
async function report(env: Env, w: Outside, fleet: string, project: string, s: Stored, text: string, now: number): Promise<boolean> {
  const d = db(env, fleet, project);
  const got = await d.batch([
    ["SELECT parent AS n FROM parents WHERE n = ?", s.n],
    ["DELETE FROM waits WHERE blocker = ? RETURNING n", s.n],
  ]);
  const waiting = (got[1] as unknown as { n: number }[]).map((x) => x.n);
  const to = [...new Set([...(got[0] as unknown as { n: number }[]).map((x) => x.n), ...waiting])];
  if (!to.length) return false;
  await d.batch(to.map((n): Op => ["INSERT INTO notes (n, at, by, verdict, text) VALUES (?, ?, ?, NULL, ?)", n, now, FACTORY, text]));
  let woke = false;
  for (const n of waiting) {
    const left = await d.first<{ c: number }>("SELECT count(*) AS c FROM waits WHERE n = ?", n);
    if (!left?.c && (await wake(env, w, fleet, project, n, FACTORY, now, idOf(project, s.n)))) woke = true;
  }
  return woke;
}

/** Текст тикета для сессии: что сделать, замечание возврата, заметки, которых сессия ещё не получала (повторные находки, слово человека, итоги тикетов), и чем работа кончается. */
function body(id: string, s: Stored, last: { back?: string; notes: Fresh[] }): string {
  return [
    `Тикет ${id}: ${s.title}`,
    ...(s.text ? ["", fill(s.text, id)] : []),
    ...(last.back ? ["", `Вернули с замечанием: ${last.back}`] : []),
    ...(last.notes.length ? ["", pack(id, last.notes)] : []),
    "",
    `Работа кончается вердиктом — инструмент ticket_set: {"ticket":"${id}","verdict":"done","note":"что сделано"}. Вернуть с замечанием — verdict "back"; нужен человек — verdict "stop" с вопросом в note. Ждёшь чужого тикета — усыпи свой: {"ticket":"${id}","after":["номер тикета"],"note":"чего ждёшь"} — он вернётся тебе с итогом; ждёшь времени — {"ticket":"${id}","in":"40m"}.`,
  ].join("\n");
}

/** Тикет встал: кому об этом сказать. «Стоп» платформы — службы или машины — идёт событием правила stop: тикетом посту-надзирателю с ключом
 *  вставшего тикета; пока такой тикет открыт, повтор ложится в него заметкой. Людей проекта зовут, когда надзиратель уже разбирал этот тикет
 *  (его тикет закрыт), встал тикет самого надзирателя, «стоп» — слово сессии или человека либо правила stop у проекта нет. */
async function fell(env: Env, w: Outside, fleet: string, project: string, def: FactoryDef | null, s: Stored, by: string, now: number): Promise<void> {
  const id = idOf(project, s.n);
  const rule = def?.on.find((r) => r.name === MACHINE_RULES.stop);
  if (def && rule && (by === FACTORY || kindOf(by) === "machine") && s.rule !== rule.name) {
    const past = await db(env, fleet, project).first<{ state: TicketState }>("SELECT state FROM tickets WHERE rule = ? AND key = ? ORDER BY n DESC LIMIT 1", rule.name, id);
    if (past?.state !== "done") {
      const f = await found(env, w, fleet, project, def, rule, { key: id, text: `${id} встал: ${s.why ?? ""}\n${s.title}`, by: FACTORY }, newId("t"), now);
      await ruleLine(env, w, fleet, project, rule.name, "name", f.note ? "note" : "ticket", { text: s.why ?? "", data: { ticket: f.id, by: FACTORY, fell: id } });
      return;
    }
  }
  await call(env, w, fleet, def, `Тикет ${id} встал`, `${s.title} — ${s.why ?? ""}`);
}

/** Тикет в «стоп» с причиной — если он ещё в том состоянии, из которого его ставят. Итог — заведшему и ждущим. Ответ — тикет и проснулся ли кто. */
async function stop(env: Env, w: Outside, fleet: string, project: string, n: number, from: TicketState, why: string, by: string, def: FactoryDef | null, now = Date.now()): Promise<{ s: Stored; woke: boolean } | null> {
  const got = await db(env, fleet, project).batch([
    ["UPDATE tickets SET state = 'stop', why = ?1, moved = ?2, until = NULL WHERE n = ?3 AND state = ?4 RETURNING *", why, now, n, from],
    ["INSERT INTO notes (n, at, by, verdict, text) SELECT ?1, ?2, ?3, 'stop', ?4 WHERE changes() > 0", n, now, by, why],
  ]);
  const s = (got[0]![0] as unknown as Stored | undefined) ?? null;
  if (!s) return null;
  await trail(env, w, fleet, project, s, "stop", by, why);
  await fell(env, w, fleet, project, def, s, by, now);
  return { s, woke: await report(env, w, fleet, project, s, `${idOf(project, n)} встал: ${why}`, now) };
}

/** Кому идут вопросы сессии по тикету: создателю тикета — человеку или сессии (не ей самой); тикет завело правило входа — человеку из call проекта. */
function askerOf(def: FactoryDef | null, s: Pick<Stored, "by">, session: string): string | undefined {
  const kind = kindOf(s.by);
  if (kind === "session") return s.by === session ? undefined : s.by;
  return kind === "person" || kind === "device" ? s.by : def?.call?.[0];
}

/** Отдать взятый тикет сессии: запрос «дать работу» машине и срок работы на часах. Машина отказала — «стоп» с её словами. */
async function give(env: Env, w: Outside, fleet: string, project: string, def: FactoryDef | null, s: Stored, trace: string): Promise<void> {
  const id = idOf(project, s.n);
  const d = db(env, fleet, project);
  const session = s.session!;
  const name = sessionName(session);
  // документ сессии поста — из определения поста (сессии нет — машина откроет её); сессии вне определения — без документа
  const post = def?.posts ? postOf(def.posts, session)?.post : undefined;
  const spec = post
    ? ({ name, cwd: post.cwd, project, key: post.key, model: post.model, ...(post.pieces ? { pieces: post.pieces } : {}), ...(post.title ? { title: post.title } : {}) } as Spec)
    : undefined;
  // заметки, которых сессия ещё не получала: после последней выданной ей, а у новой сессии тикета — после последнего вердикта.
  // Номер последней заметки тикета запоминается в записи: что придёт позже, сессия увидит до того, как тикет закроет
  // граница тикета: разговор сессии поста начинается заново перед каждым тикетом (fresh) или перед тикетом другого предмета (thread).
  // Тот же тикет подряд разговор продолжает всегда. Сжатие большого разговора решает машина: размер знает она
  const talk = post ? await d.first<{ n: number; key: string | null }>("SELECT n, key FROM talks WHERE session = ?", session) : null;
  const clear = !!post && talk?.n !== s.n && (post.context === "fresh" || (post.context === "thread" && !(s.key && talk?.key === s.key)));
  // после «заново» прежних заметок в разговоре нет: тикет несёт их как новой сессии
  const ran = runOf(s);
  const seen = !clear && ran?.s === session ? ran.seen : undefined;
  const notes = await d.batch([
    ["SELECT text FROM notes WHERE n = ? AND verdict = 'back' ORDER BY at DESC LIMIT 1", s.n],
    ["SELECT rowid, by, text FROM notes WHERE n = ?1 AND verdict IS NULL AND rowid > coalesce(?2, (SELECT max(rowid) FROM notes WHERE n = ?1 AND verdict IS NOT NULL), 0) ORDER BY rowid", s.n, seen ?? null],
    ["SELECT coalesce(max(rowid), 0) AS top FROM notes WHERE n = ?", s.n],
  ]);
  const last = { back: s.returns ? (notes[0]![0] as { text?: string } | undefined)?.text : undefined, notes: notes[1] as unknown as Fresh[] };
  const kept = runs({ s: session, seen: (notes[2]![0] as { top: number }).top });
  await d.run("UPDATE tickets SET runs = ? WHERE n = ? AND state = 'work'", kept, s.n);
  const now_ = { ...s, runs: kept };
  const r = await toMachine(w, fleet, trace, {
    type: "work.give", to: "@" + machineOf(session), name, ticket: id, text: body(id, now_, last),
    ...(spec ? { spec } : {}), ...(s.rule ? { on: s.rule } : {}), ...(s.key ? { key: s.key } : {}), ...(s.files ? { files: JSON.parse(s.files) as FileIn[] } : {}),
    ...(askerOf(def, s, session) ? { asker: askerOf(def, s, session) } : {}), ...(clear ? { clear: true } : {}),
  });
  if (!r.ok) {
    // итог вставшего тикета мог разбудить ждущих: они раздаются сразу
    const st = await stop(env, w, fleet, project, s.n, "work", `работа не дана: ${r.why}`, FACTORY, def);
    if (st?.woke) await run(env, w, fleet, project, trace);
    return;
  }
  if (post?.context === "thread" || post?.context === "fresh") await d.run("INSERT INTO talks (session, n, key) VALUES (?1, ?2, ?3) ON CONFLICT (session) DO UPDATE SET n = ?2, key = ?3", session, s.n, s.key);
  await set(env, fleet, { id: timer(project, s.n), kind: TERM, at: s.until!, input: { project, n: s.n } });
  await trail(env, w, fleet, project, now_, "given", FACTORY, "", { ...(clear ? { clear: true } : {}), ...(s.key ? { key: s.key } : {}) });
}

/** Раздать готовое. Место берётся одной записью — два одновременных события не запустят тикет дважды. У сессии один тикет в работе.
 *  Сначала сессия получает своё (возврат, проснувшийся, тикет по позывному), потом свободные сессии поста берут из его очереди:
 *  срочный, потом старший. У поста «по предмету» занят предмет, а не исполнитель: тикет, чей предмет в работе у другой сессии поста,
 *  не выдаётся — ни из очереди, ни свой; среди обычных сессия берёт сначала свой предмет — тот, о котором её разговор.
 *  Запросы не перечисляют посты и сессии: число значений в каждом от размера определения не зависит. Проект на паузе — тикеты не выдаются. */
export async function run(env: Env, w: Outside, fleet: string, project: string, trace: string, now = Date.now()): Promise<void> {
  const a = await applied(env, fleet, project);
  if (a?.row.paused) return;
  const def = a?.def ?? null;
  // посты «по предмету» — одним значением: имена читает сам запрос
  const threads = JSON.stringify(Object.entries(def?.posts ?? {}).filter(([, p]) => p.context === "thread").map(([name]) => name));
  /** Предмет тикета t в работе у другой сессии его поста; me — сессия, которой тикет достался бы. */
  const held = (me: string) => `(t.key IS NOT NULL AND EXISTS (SELECT 1 FROM tickets b WHERE b.state = 'work' AND b.dest = t.dest AND b.key = t.key AND b.session <> ${me}))`;
  const ops: Op[] = [
    // своё — сессии: по одному на свободную сессию
    [
      `UPDATE tickets SET state = 'work', moved = ?, until = ? + term, session = target WHERE n IN (
         SELECT n FROM (
           SELECT t.n, row_number() OVER (PARTITION BY t.target ORDER BY t.rank, t.n) AS same
           FROM tickets t WHERE t.state = 'ready' AND t.target LIKE '%@%' AND NOT EXISTS (SELECT 1 FROM tickets b WHERE b.state = 'work' AND b.session = t.target)
             AND NOT (t.dest IN (SELECT value FROM json_each(?)) AND ${held("t.target")})
         ) WHERE same = 1
       ) RETURNING *`,
      now, now, threads,
    ],
  ];
  // очередь поста: каждая свободная сессия берёт срочный, потом старший; у поста «по предмету» — срочный, свой предмет, старший
  for (const [name, post] of Object.entries(def?.posts ?? {}))
    for (const session of postSessions(name, post))
      ops.push(
        post.context === "thread"
          ? [
              `UPDATE tickets SET state = 'work', moved = ?1, until = ?1 + term, session = ?2 WHERE n = (
                 SELECT t.n FROM tickets t WHERE t.state = 'ready' AND t.target = ?3 AND NOT ${held("?2")}
                 ORDER BY t.rank, coalesce(t.key = (SELECT key FROM talks WHERE session = ?2), 0) DESC, t.n LIMIT 1
               ) AND NOT EXISTS (SELECT 1 FROM tickets b WHERE b.state = 'work' AND b.session = ?2) RETURNING *`,
              now, session, name,
            ]
          : [
              `UPDATE tickets SET state = 'work', moved = ?, until = ? + term, session = ? WHERE n = (
                 SELECT t.n FROM tickets t WHERE t.state = 'ready' AND t.target = ? ORDER BY t.rank, t.n LIMIT 1
               ) AND NOT EXISTS (SELECT 1 FROM tickets b WHERE b.state = 'work' AND b.session = ?) RETURNING *`,
              now, now, session, name, session,
            ],
      );
  const taken = (await db(env, fleet, project).batch(ops)).flat() as unknown as Stored[];
  await Promise.all(taken.map((s) => give(env, w, fleet, project, def, s, trace)));
}

/** После движения тикета: срок на часах, зов человека, итог заведшему и ждущим, строка истории и раздача готового. */
async function settle(env: Env, w: Outside, fleet: string, project: string, def: FactoryDef | null, was: Stored | null, s: Stored, move: string, by: string, note: string, trace: string): Promise<void> {
  const id = idOf(project, s.n);
  const now = Date.now();
  if (was?.state === "work" && s.state !== "work") await drop(env, fleet, { id: timer(project, s.n) });
  // тикет больше не спит: его срок и названные ожидания сняты — кто бы его ни разбудил, передал или снял
  if (was?.state === "wait" && s.state !== "wait") {
    await drop(env, fleet, { id: startTimer(project, s.n) });
    await db(env, fleet, project).run("DELETE FROM waits WHERE n = ?", s.n);
  }
  // у назначения — из какого состояния тикет ушёл: «из работы» — его передала сессия, которая его вела
  await trail(env, w, fleet, project, s, move, by, note, { ...(move === "assign" && was ? { from: was.state } : {}), ...(move === "defer" && s.start ? { start: s.start } : {}) });
  if (s.state === "stop" && was?.state !== "stop") {
    await fell(env, w, fleet, project, def, s, by, now);
    await report(env, w, fleet, project, s, `${id} встал: ${s.why ?? ""}`, now);
  }
  if (s.state === "done" && was?.state !== "done") await report(env, w, fleet, project, s, `${id} ${s.dropped ? "снят" : "сдан"}${note ? `: ${note}` : ""}`, now);
  await run(env, w, fleet, project, trace);
}

// срок работы вышел, а вердикта нет: «стоп»; тикет уже не в работе — срок не про него
on(TERM, async (env, fleet, input, w) => {
  const { project, n } = input as { project: string; n: number };
  const got = await db(env, fleet, project).first<Stored>("SELECT * FROM tickets WHERE n = ? AND state = 'work' AND until <= ?", n, w.now);
  if (!got) return;
  const def = (await applied(env, fleet, project))?.def ?? null;
  if (!(await stop(env, w, fleet, project, n, "work", "срок вышел", FACTORY, def, w.now))) return;
  await run(env, w, fleet, project, newId("t"), w.now);
});

const outside = (ctx: Ctx): Outside => ({ platform: ctx.platform, fetch: ctx.fetch, log: ctx.log });

/* ===== Правка тикета и вердикт ===== */

/** Почему пришедшему нельзя сделать это с тикетом; можно — null. Одно правило: им отказывает запись и по нему чтение называет доступные действия.
 *  Вердикт тикету в работе: сессия — только та, что его ведёт; машина — тикету своей сессии; человек — любому. */
function barred(id: string, was: Pick<Stored, "state" | "session">, by: string, act: TicketAct): Refusal | null {
  if (act === "verdict") {
    if (was.state !== "work") return new Refusal("bad_state", `тикет ${id} — ${was.state}: вердикт дают тикету в работе`);
    const kind = kindOf(by);
    if (kind === "session" && was.session !== by) return new Refusal("not_yours", `тикет ${id} ведёт ${was.session ?? "не сессия"}`);
    if (kind === "machine" && machineOf(was.session ?? "") !== machineOf(by)) return new Refusal("not_yours", `тикет ${id} ведёт сессия другой машины`);
    return null;
  }
  if (act === "resume") return was.state === "stop" || was.state === "wait" ? null : new Refusal("bad_state", `тикет ${id} — ${was.state}: в очередь возвращают вставший или спящий`);
  if (act === "drop") return was.state === "done" ? new Refusal("bad_state", `тикет ${id} уже закрыт`) : null;
  if (was.state === "done") return new Refusal("bad_state", `тикет ${id} уже закрыт: исполнителя не меняют`);
  // тикет в работе передаёт другому исполнителю только сессия, которая его ведёт
  if (was.state === "work" && !(kindOf(by) === "session" && was.session === by)) return new Refusal("bad_state", `тикет ${id} — work: тикет в работе передаёт сессия, которая его ведёт; остальным — тикет в очереди, спящий или вставший`);
  return null;
}
const ACTS: TicketAct[] = ["verdict", "resume", "drop", "assign"];

/** Правки одного тикета от одного автора. Каждая проходит, только если тикет всё ещё в том же состоянии; заметка — той же пачкой.
 *  Тикет уже ушёл — отказ bad_state. planned — правка по плану. */
function mover(env: Env, fleet: string, project: string, def: FactoryDef | null, was: Stored, by: string, now: number) {
  const d = db(env, fleet, project);
  const move = async (sets: string, params: (string | number | null)[], verdict: Verdict | null, text: string): Promise<Stored> => {
    const ops: Op[] = [[`UPDATE tickets SET ${sets}, moved = ? WHERE n = ? AND state = ? RETURNING *`, ...params, now, was.n, was.state]];
    if (verdict || text) ops.push(["INSERT INTO notes (n, at, by, verdict, text) SELECT ?, ?, ?, ?, ? WHERE changes() > 0", was.n, now, by, verdict, text]);
    const s = (await d.batch(ops))[0]![0] as unknown as Stored | undefined;
    if (!s) throw new Refusal("bad_state", `тикет ${idOf(project, was.n)} уже изменён: прочитайте его заново`);
    return s;
  };
  const planned = (extra: string, more: (string | number | null)[], verdict: Verdict | null, text: string) => {
    const { sets, params } = planSets(plan(def, was));
    return move(sets + extra, [...params, ...more], verdict, text);
  };
  return { move, planned };
}

/** Вердикт тикету в работе — от сессии, машины или человека. «Сдал» закрывает тикет; «стоп» ставит с причиной; «вернул» возвращает его
 *  той же сессии, второй возврат — «стоп». same — возврат оставляет тикет в работе: проверка поста не прошла. Ответ — тикет после правки
 *  и слово движения для истории. */
async function decide(env: Env, fleet: string, project: string, def: FactoryDef | null, was: Stored, v: { verdict: Verdict; note: string; by: string; same?: boolean }, now: number): Promise<{ s: Stored; word: string }> {
  const { move, planned } = mover(env, fleet, project, def, was, v.by, now);
  let s: Stored;
  if (v.verdict === "done") s = await move("state = 'done', until = NULL, why = NULL, target = NULL", [], "done", v.note);
  else if (v.verdict === "stop") s = await move("state = 'stop', until = NULL, why = ?", [v.note || "нужен человек"], "stop", v.note);
  else {
    const again = was.returns + 1;
    if (again >= RETURNS) s = await move("state = 'stop', until = NULL, why = 'второй возврат', returns = ?", [again], "back", v.note);
    else if (v.same) s = await move("returns = ?", [again], "back", v.note);
    else s = await planned(", returns = ?", [again], "back", v.note);
  }
  return { s, word: s.state === "stop" && v.verdict === "back" ? "stop" : v.verdict };
}

/* ===== Сон ===== */

/** Тикеты, которых названный собирается ждать: каждый есть в этом проекте, и ни один не ждёт его самого — иначе круг не кончится. Ответ — их номера. */
async function blockers(env: Env, fleet: string, project: string, n: number | null, after: string[]): Promise<number[]> {
  const d = db(env, fleet, project);
  const ids = [...new Set(after.map((id) => {
    const p = parse(id);
    if (p.project !== project) throw new Refusal("bad_input", `тикет ${id} — другого проекта: ждут тикеты своего`);
    return p.n;
  }))];
  const have = new Set((await d.all<{ n: number }>(`SELECT n FROM tickets WHERE n IN (${ids.map(() => "?").join(", ")})`, ...ids)).map((x) => x.n));
  const none = ids.find((x) => !have.has(x));
  if (none !== undefined) throw new Refusal("no_ticket", `тикета ${idOf(project, none)} нет`);
  if (n === null) return ids;
  if (ids.includes(n)) throw new Refusal("bad_input", "тикет не ждёт сам себя");
  // круг: кто-то из названных — сам или через своих — уже ждёт этот тикет
  let edge = ids;
  for (let depth = 0; depth < 20 && edge.length; depth++) {
    edge = (await d.all<{ blocker: number }>(`SELECT DISTINCT blocker FROM waits WHERE n IN (${edge.map(() => "?").join(", ")}) LIMIT 50`, ...edge)).map((x) => x.blocker);
    if (edge.includes(n)) throw new Refusal("bad_input", `круг ожидания: один из названных тикетов сам ждёт ${idOf(project, n)}`);
  }
  return ids;
}

/** Усыплённый тикет записывает, кого ждёт, и ставит свой срок на часы. Ждут только тикеты без итога — в очереди, в работе или спящие; у остальных
 *  итог уже есть. Ждать нечего и срока нет — тикет сразу просыпается. Ответ — проснулся ли. */
async function slept(env: Env, w: Outside, fleet: string, project: string, s: Stored, ids: number[], now: number): Promise<boolean> {
  const d = db(env, fleet, project);
  const open = ids.length
    ? await d.all<{ n: number }>(`INSERT OR IGNORE INTO waits (n, blocker) SELECT ?, n FROM tickets WHERE n IN (${ids.map(() => "?").join(", ")}) AND state IN ('ready', 'work', 'wait') RETURNING blocker AS n`, s.n, ...ids)
    : [];
  if (s.start) await set(env, fleet, { id: startTimer(project, s.n), kind: START, at: s.start, input: { project } });
  return !open.length && !s.start ? wake(env, w, fleet, project, s.n, FACTORY, now) : false;
}

// спящий тикет дождался своего срока: просыпается, даже если названные тикеты ещё без итога — срок рядом с ними — предел ожидания
on(START, async (env, fleet, input, w) => {
  const { project } = input as { project: string };
  for (const { n } of await db(env, fleet, project).all<{ n: number }>("SELECT n FROM tickets WHERE state = 'wait' AND start IS NOT NULL AND start <= ?", w.now)) await wake(env, w, fleet, project, n, FACTORY, w.now);
  await run(env, w, fleet, project, newId("t"), w.now);
});

/* ===== Новый тикет и правила входа ===== */

type Draft = { title: string; text: string; to: string | null; by: string; key?: string; rule?: string; term: number | null; start?: number; after?: number[]; first?: boolean; files?: FileIn[] };

/** Завести тикет: запись и её место — одной пачкой, тикет не виден «в очереди» раньше, чем узнал свою цель. Тикет со сроком или ожиданиями
 *  заводится спящим. Исполнителю негде встать — отказ. */
async function create(env: Env, w: Outside, fleet: string, project: string, def: FactoryDef | null, t: Draft, now: number): Promise<Stored> {
  const p = plan(def, { dest: t.to, term: t.term, runs: "{}" });
  if (p.state === "stop") throw new Refusal("no_dest", p.why);
  const { sets, params } = planSets(p);
  const sleeps = !!(t.start || t.after?.length);
  const got = await db(env, fleet, project).batch([
    [
      "INSERT INTO tickets (title, text, dest, state, by, key, rule, since, moved, term, start, rank, files) VALUES (?, ?, ?, 'ready', ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      t.title, t.text, t.to, t.by, t.key ?? null, t.rule ?? null, now, now, t.term, t.start ?? null, t.first ? FIRST : 0, t.files?.length ? JSON.stringify(t.files) : null,
    ],
    [`UPDATE tickets SET ${sets}${sleeps ? ", state = 'wait'" : ""} WHERE n = last_insert_rowid() RETURNING *`, ...params],
  ]);
  const made = got[1]![0] as unknown as Stored;
  if (sleeps && (await slept(env, w, fleet, project, made, t.after ?? [], now))) return { ...made, state: "ready", start: null };
  return made;
}

/** Откуда событие правила входа: срок часов, зов по имени или запрос на адрес с секретом. */
type Source = "time" | "name" | "hook";
/** Что принесло событие: ключ (нет — ключ правила или его имя), текст, файлы и кто его прислал. */
type Found = { key?: string; text: string; files?: FileIn[]; by: string };

/** Строка истории «rule»: исход одного срабатывания правила входа. */
const ruleLine = (env: Env, w: Outside, fleet: string, project: string, rule: string, source: Source, outcome: string, o: { machine?: string; text?: string; data?: Record<string, unknown> } = {}) =>
  history(env, w, fleet, { msg: "rule", kind: outcome, who: o.machine, text: o.text, data: { project, rule, source, ...o.data } });

/** Событие правила входа: открытый тикет с тем же правилом и ключом получает его заметкой, а файлы — к своим; иначе — новый тикет посту правила.
 *  Спящий тикет заметка не будит. */
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
  const made = await create(env, w, fleet, project, def, { title: rule.title ?? rule.name, text: [rule.text, f.text].filter(Boolean).join("\n\n"), to: rule.to, by: f.by, key, rule: rule.name, term: null, files: f.files }, now);
  await settle(env, w, fleet, project, def, null, made, "new", f.by, made.title, trace);
  return { id: idOf(project, made.n), note: false };
}

type Asked = { project: string; to?: string; title: string; text?: string; key?: string; for?: string; in?: string; after?: string[]; first?: boolean; files?: FileIn[]; by: string };

/** Новый тикет по просьбе: исполнитель — пост проекта или сессия флота со сроком; запись и её место. Правило одно для пришедшего и для соседней службы. */
async function make(env: Env, w: Outside, fleet: string, i: Asked): Promise<{ def: FactoryDef | null; made: Stored }> {
  const def = (await applied(env, fleet, i.project))?.def ?? null;
  const now = Date.now();
  if (i.to !== undefined && !def?.posts?.[i.to]) {
    if (kindOf(i.to) !== "session") throw new Refusal("no_dest", `исполнителя ${i.to} нет: поста с таким именем у проекта ${i.project} нет; сессии — позывной вида site@laptop`);
    if (!i.for) throw new Refusal("no_term", "тикету сессии нужен срок работы: for — 20m, 2h, 1d");
    if (!(await within(w.platform.sessions(fleet), CALL_MS, "платформа не назвала сессии")).some((s) => s.callsign === i.to)) throw new Refusal("no_session", `сессии ${i.to} нет во флоте`);
  }
  if ((i.in || i.after) && i.to === undefined) throw new Refusal("bad_input", "спать может тикет с исполнителем: назовите to");
  // работу посту с раздающими даёт сессия раздающего; предмет посту «по предмету» сессия называет сама: без него срез пошёл бы
  // рядом с соседом в то же место
  const refusal = ungiven(def, i.by, i.to);
  if (refusal) throw refusal;
  const dest = doer(def, i.to);
  if (kindOf(i.by) === "session" && !i.key && dest?.post.context === "thread") throw new Refusal("bad_input", `посту ${dest.name} нужен key — предмет тикета: место кода или тема; тикеты одного предмета идут одной сессии по очереди`);
  const after = i.after ? await blockers(env, fleet, i.project, null, i.after) : undefined;
  const made = await create(
    env, w, fleet, i.project, def,
    { title: i.title, text: i.text ?? "", to: i.to ?? null, by: i.by, key: i.key, files: i.files, term: i.for ? termMs(i.for) : null, first: i.first, after, ...(i.in ? { start: now + termMs(i.in) } : {}) },
    now,
  );
  return { def, made };
}

/** Тикет от соседней службы: проект называет она, участие в проекте не сверяется — пришедшего с пропуском за ней нет. Ответ — номер тикета. */
export async function raise(env: Env, w: Outside, fleet: string, i: Asked & { trace: string }): Promise<{ id: string }> {
  const { def, made } = await make(env, w, fleet, i);
  await settle(env, w, fleet, i.project, def, null, made, "new", i.by, i.title, i.trace);
  return { id: idOf(i.project, made.n) };
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
  for (const [name, post] of Object.entries(def.posts)) {
    place(`posts.${name}.at`, post.at);
    for (const p of post.pieces ?? []) if (!repos.includes(splitPiece(p)?.repo ?? "")) errors.push(`posts.${name}.pieces: роли ${p} нет в репозиториях флота (${REPOS})`);
    // вторая и следующие сессии поста зовутся имя-2, имя-3: такое имя не должно быть занято
    for (const session of postSessions(name, post).slice(1).map(sessionName)) if (def.posts[session]) errors.push(`posts.${name}.size: имя сессии ${session} занято постом`);
    for (const g of post.givers ?? []) if (!def.posts[g]) errors.push(`posts.${name}.givers: поста ${g} нет в posts`);
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
    if (!def.posts[rule.to]) errors.push(`${path}.to: поста ${rule.to} нет в posts`);
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
    async "ticket.new"(i: { project?: string; to?: string; title?: string; text?: string; key?: string; for?: string; in?: string; after?: string[]; first?: boolean; on?: string; files?: FileIn[] }, ctx) {
      const project = await projectOf(ctx, i.project);
      if (i.on !== undefined) {
        // событие правила входа: исполнитель, название и срок — у правила
        if (i.to !== undefined || i.title !== undefined || i.for || i.in || i.after || i.first !== undefined) throw new Refusal("bad_input", "событие правила входа несёт только on, key, text и files: исполнитель и название — у правила");
        return { id: (await event(ctx.env, outside(ctx), ctx.fleet, { project, rule: i.on, source: "name", key: i.key, text: i.text ?? "", files: i.files, by: ctx.who.addr, trace: ctx.trace })).id };
      }
      if (!i.title) throw new Refusal("bad_input", "тикету нужно название: title");
      const { def, made } = await make(ctx.env, outside(ctx), ctx.fleet, { ...i, title: i.title, project, by: ctx.who.addr });
      // тикет, заведённый сессией со своего тикета в работе, помнит его: итог ляжет туда заметкой
      if (kindOf(ctx.who.addr) === "session") {
        const d = db(ctx.env, ctx.fleet, project);
        const up = await d.first<{ n: number }>("SELECT n FROM tickets WHERE state = 'work' AND session = ? AND n <> ? LIMIT 1", ctx.who.addr, made.n);
        if (up) await d.run("INSERT INTO parents (n, parent) VALUES (?, ?)", made.n, up.n);
      }
      ctx.after(settle(ctx.env, outside(ctx), ctx.fleet, project, def, null, made, "new", ctx.who.addr, i.title, ctx.trace));
      return { id: idOf(project, made.n) };
    },

    async "ticket.list"(i: { project?: string; ticket?: string; to?: string; state?: TicketState; session?: string; key?: string }, ctx) {
      const d = (project: string) => db(ctx.env, ctx.fleet, project);
      if (i.ticket) {
        const { project, n } = parse(i.ticket);
        await member(ctx, project);
        const got = await d(project).batch([
          [`SELECT ${WITH} WHERE t.n = ?`, n],
          ["SELECT at, by, verdict, text FROM notes WHERE n = ? ORDER BY at", n],
        ]);
        const s = got[0]![0] as unknown as Stored | undefined;
        if (!s) throw new Refusal("no_ticket", `тикета ${i.ticket} нет`);
        const notes = (got[1] as unknown as { at: number; by: string; verdict: Verdict | null; text: string }[]).map((x) => ({ at: x.at, by: x.by, text: x.text, ...(x.verdict ? { verdict: x.verdict } : {}) }));
        const acts = ACTS.filter((act) => !barred(i.ticket!, s, ctx.who.addr, act));
        return { tickets: [{ ...ticket(project, s, (await applied(ctx.env, ctx.fleet, project))?.def ?? null, await watched(d(project)), { notes }), acts }] };
      }
      const project = await projectOf(ctx, i.project);
      const where = ["1 = 1"];
      const params: (string | number)[] = [];
      if (i.state) (where.push("t.state = ?"), params.push(i.state));
      if (i.to) (where.push("t.dest = ?"), params.push(i.to));
      if (i.session) (where.push("t.session = ?"), params.push(i.session));
      if (i.key) (where.push("t.key = ?"), params.push(i.key));
      // строка списка — без текста: текст тикета читают по его номеру
      const rows = await d(project).all<Stored>(`SELECT ${ROW} WHERE ${where.join(" AND ")} ORDER BY t.n DESC LIMIT 500`, ...params);
      const def = (await applied(ctx.env, ctx.fleet, project))?.def ?? null;
      const busy = rows.some((s) => s.state === "stop") ? await watched(d(project)) : new Set<string>();
      return { tickets: rows.map((s) => ticket(project, s, def, busy)) };
    },

    async "ticket.set"(i: { ticket: string; verdict?: Verdict; note?: string; to?: string; for?: string; resume?: boolean; drop?: boolean; in?: string; after?: string[]; first?: boolean }, ctx) {
      const { project, n } = parse(i.ticket);
      await member(ctx, project);
      const d = db(ctx.env, ctx.fleet, project);
      const was = await d.first<Stored>("SELECT * FROM tickets WHERE n = ?", n);
      if (!was) throw new Refusal("no_ticket", `тикета ${i.ticket} нет`);
      if ([i.verdict, i.resume, i.drop, i.in || i.after, i.to].filter(Boolean).length > 1) throw new Refusal("bad_input", "одно из пяти: verdict, resume, drop, сон (in, after) или to");
      // срочность меняют отдельной правкой или вместе с исполнителем: рядом с вердиктом, сном, resume и drop она бы молча потерялась
      if (i.first !== undefined && (i.verdict || i.resume || i.drop || i.in || i.after)) throw new Refusal("bad_input", "first — отдельной правкой или вместе с to");
      const def = (await applied(ctx.env, ctx.fleet, project))?.def ?? null;
      const by = ctx.who.addr;
      const now = Date.now();
      const note = i.note ?? "";
      const w = outside(ctx);
      const { move, planned } = mover(ctx.env, ctx.fleet, project, def, was, by, now);
      /** Отказ, если пришедшему это с тикетом нельзя. */
      const no = (act: TicketAct) => {
        const refusal = barred(i.ticket, was, by, act);
        if (refusal) throw refusal;
      };
      let s: Stored;
      let word: string;
      if (i.verdict) {
        no("verdict");
        // «сдал» от сессии, которая не видела пришедших заметок: один отказ с их текстом — что ей показано, записано в тикете, второй «сдал» пройдёт
        if (i.verdict === "done" && kindOf(by) === "session") {
          const ran = runOf(was);
          const fresh = await d.all<Fresh>("SELECT rowid, by, text FROM notes WHERE n = ? AND verdict IS NULL AND rowid > ? AND by <> ? ORDER BY rowid", n, ran?.seen ?? 0, by);
          if (fresh.length) {
            await d.run("UPDATE tickets SET runs = ? WHERE n = ? AND state = 'work'", runs({ s: ran?.s ?? by, seen: fresh.at(-1)!.rowid }), n);
            ctx.after(trail(ctx.env, w, ctx.fleet, project, was, "unread", by, "", { notes: fresh.length }));
            throw new Refusal("unread", `к тикету ${i.ticket} пришли заметки, которых ты ещё не видела. Учти их и сдай снова.\n${pack(i.ticket, fresh)}`);
          }
        }
        // возврат от машины сессии — проверка поста не прошла: тикет остаётся у той же сессии
        ({ s, word } = await decide(ctx.env, ctx.fleet, project, def, was, { verdict: i.verdict, note, by, same: kindOf(by) === "machine" }, now));
      } else if (i.in || i.after) {
        // сессия усыпляет тикет, который ведёт: место свободно, тикет вернётся ей — с итогом названных тикетов или по сроку, что раньше
        if (was.state !== "work") throw new Refusal("bad_state", `тикет ${i.ticket} — ${was.state}: усыпляют тикет в работе`);
        if (was.session !== by) throw new Refusal("not_yours", `тикет ${i.ticket} ведёт ${was.session ?? "не сессия"}: усыпить его может только она`);
        const after = i.after ? await blockers(ctx.env, ctx.fleet, project, n, i.after) : [];
        s = await move("state = 'wait', target = ?, session = NULL, until = NULL, start = ?", [by, i.in ? now + termMs(i.in) : null], null, note);
        if (await slept(ctx.env, w, ctx.fleet, project, s, after, now)) s = { ...s, state: "ready", start: null };
        word = "defer";
      } else if (i.resume) {
        no("resume");
        // спящий просыпается к своей цели; вставший встаёт в очередь заново
        s = was.state === "wait" ? await move("state = 'ready', start = NULL", [], null, note || "разбужен") : await planned(", returns = 0", [], null, note || "возвращён в очередь");
        word = "resume";
      } else if (i.drop) {
        no("drop");
        s = await move("state = 'done', until = NULL, target = NULL, dropped = 1", [], null, note || "снят");
        word = "drop";
      } else {
        // правка без вердикта: исполнитель, срок, срочность, заметка
        const term = i.for ? termMs(i.for) : was.term;
        if (i.to !== undefined) {
          no("assign");
          const refusal = ungiven(def, by, i.to);
          if (refusal) throw refusal;
          const p = plan(def, { ...was, dest: i.to, term, runs: "{}" });
          if (p.state === "stop") throw new Refusal(kindOf(i.to) === "session" && !term ? "no_term" : "no_dest", p.why);
          // вставший тикет исполнителя меняет, но в очередь не идёт: его возвращает resume
          const { sets, params } = was.state === "stop" ? { sets: "term = ?", params: [p.term] } : planSets(p);
          s = await move(`${sets}, dest = ?, runs = '{}', start = NULL` + (i.first !== undefined ? ", rank = ?" : ""), [...params, i.to, ...(i.first !== undefined ? [i.first ? FIRST : 0] : [])], null, note);
          word = "assign";
        } else {
          const sets: string[] = [];
          const params: (string | number | null)[] = [];
          if (i.for) (sets.push("term = ?"), params.push(term));
          if (i.first !== undefined) {
            if (was.state === "done") throw new Refusal("bad_state", `тикет ${i.ticket} уже закрыт`);
            (sets.push("rank = ?"), params.push(i.first ? FIRST : 0));
          }
          if (!sets.length && !note) throw new Refusal("bad_input", "нечего менять: назовите verdict, resume, drop, in, after, to, for, first или note");
          s = await move(sets.length ? sets.join(", ") : "n = n", params, null, note);
          word = "note";
        }
      }
      ctx.after(settle(ctx.env, w, ctx.fleet, project, def, was, s, word, by, note, ctx.trace));
      return { id: i.ticket, state: s.state };
    },

    async "factory.apply"(i: { project: string; repo: string }, ctx) {
      await member(ctx, i.project);
      const w = outside(ctx);
      const refused = (e: Refusal) => history(ctx.env, w, ctx.fleet, { msg: "factory", kind: "refused", who: ctx.who.addr, text: `${e.word}: ${e.why ?? ""}`, data: { project: i.project, repo: i.repo, by: ctx.who.addr } });
      let def: FactoryDef;
      let commit: string;
      try {
        // где лежит файл: репозиторий ролей — в корне; кусочек в нём — в папке кусочка
        const piece = splitPiece(i.repo);
        const from = piece ? { repo: piece.repo, path: `${piece.folder}/${FACTORY_FILE}` } : { repo: i.repo, path: FACTORY_FILE };
        if (!((await fleetPref<string[]>(ctx.env, ctx.fleet, REPOS)) ?? []).includes(from.repo)) throw new Refusal("bad_factory", `репозитория ${from.repo} нет в настройке флота ${REPOS}: роли из него сессии не получат`);
        const got = await file(ctx, from.repo, from.path);
        commit = got.commit;
        def = await check(ctx, i.project, got.text);
      } catch (e) {
        if (e instanceof Refusal) ctx.after(refused(e));
        throw e;
      }
      const d = db(ctx.env, ctx.fleet, i.project);
      const before = (await applied(ctx.env, ctx.fleet, i.project))?.def ?? null;
      const now = Date.now();
      await d.run(
        "INSERT INTO def (one, repo, sha, at, by, json) VALUES (1, ?1, ?2, ?3, ?4, ?5) ON CONFLICT (one) DO UPDATE SET repo = ?1, sha = ?2, at = ?3, by = ?4, json = ?5",
        i.repo, commit, now, ctx.who.addr, JSON.stringify(def),
      );
      // сессии постов, которых в определении больше нет (пост убран или size уменьшен): их тикеты возвращаются в очередь поста —
      // из работы, свои в очереди и спящие; запись о том, кто вёл, сброшена
      const keep = new Set(Object.entries(def.posts).flatMap(([name, post]) => postSessions(name, post)));
      const gone = Object.entries(before?.posts ?? {}).flatMap(([name, post]) => postSessions(name, post)).filter((c) => !keep.has(c));
      for (const callsign of gone) {
        const back = await d.batch([
          ["UPDATE tickets SET state = 'ready', runs = '{}', target = dest, session = NULL, until = NULL, moved = ? WHERE state = 'work' AND session = ? RETURNING *", now, callsign],
          ["UPDATE tickets SET runs = '{}', target = dest WHERE state IN ('ready', 'wait') AND target = ?", callsign],
        ]);
        for (const t of back[0] as unknown as Stored[]) {
          await drop(ctx.env, ctx.fleet, { id: timer(i.project, t.n) });
          await trail(ctx.env, w, ctx.fleet, i.project, t, "resume", FACTORY, `сессии ${callsign} больше нет в определении: тикет в очереди поста`);
        }
      }
      // тикеты в очереди узнают цель заново: пост мог измениться или уйти
      for (const t of await d.all<Stored>("SELECT * FROM tickets WHERE state = 'ready' AND dest IS NOT NULL")) {
        const { sets, params } = planSets(plan(def, t));
        await d.run(`UPDATE tickets SET ${sets} WHERE n = ? AND state = 'ready'`, ...params, t.n);
      }
      await schedule(ctx.env, ctx.fleet, i.project, def, now);
      const have = new Set((await within(ctx.platform.sessions(ctx.fleet), CALL_MS, "платформа не назвала сессии")).map((s) => s.callsign));
      // лишние сессии останавливаются: их тикеты уже в очереди
      const closed: string[] = [];
      for (const callsign of gone) {
        if (!have.has(callsign)) continue;
        const r = await toMachine(w, ctx.fleet, ctx.trace, { type: "session.stop", to: callsign });
        if (r.ok) closed.push(callsign);
        else ctx.log.warn("сессия поста не остановлена", { module: NAME, fleet: ctx.fleet, callsign, why: r.why });
      }
      // сессии постов, которых ещё нет, открываются; не открылась — причина в ответе, сессия откроется с первым тикетом
      const opened: string[] = [];
      const failed: { post: string; why: string }[] = [];
      for (const [post, p] of Object.entries(def.posts))
        for (const callsign of postSessions(post, p)) {
          if (have.has(callsign)) continue;
          const name = sessionName(callsign);
          const r = await toMachine(w, ctx.fleet, ctx.trace, {
            type: "session.open", to: p.at, mkdir: true,
            spec: { name, cwd: p.cwd, key: p.key, model: p.model, project: i.project, ...(p.pieces ? { pieces: p.pieces } : {}), ...(p.title ? { title: p.title } : {}) },
          });
          if (r.ok) opened.push(callsign);
          else failed.push({ post: name, why: r.why });
        }
      ctx.after(history(ctx.env, w, ctx.fleet, { msg: "factory", kind: "applied", who: ctx.who.addr, text: commit, data: { project: i.project, repo: i.repo, commit, by: ctx.who.addr } }).then(() => run(ctx.env, w, ctx.fleet, i.project, ctx.trace)));
      return { commit, posts: Object.keys(def.posts).length, rules: def.on.length, opened, closed, failed };
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
      // очереди постов: считает служба, страница и правила проекта читают готовые числа
      const now = Date.now();
      const rows = await db(ctx.env, ctx.fleet, project).all<{ dest: string; work: number; ready: number; first: number; oldest: number | null }>(
        `SELECT dest, sum(state = 'work') AS work, sum(state = 'ready') AS ready, sum(state = 'ready' AND rank < 0) AS first, min(CASE WHEN state = 'ready' THEN moved END) AS oldest
         FROM tickets WHERE state IN ('work', 'ready') AND dest IS NOT NULL GROUP BY dest`,
      );
      const by = new Map(rows.map((r) => [r.dest, r]));
      const load = Object.fromEntries(Object.keys(a.def.posts ?? {}).map((name) => {
        const r = by.get(name);
        return [name, { work: r?.work ?? 0, ready: r?.ready ?? 0, first: r?.first ?? 0, ...(r?.oldest ? { oldest: now - r.oldest } : {}) }];
      }));
      const base = ruleTimers(project);
      const due = Object.fromEntries((await timers(ctx.env, ctx.fleet, base)).map((t) => [t.id.slice(base.length), t.at]));
      const state: FactoryState = { project, repo: a.row.repo, commit: a.row.sha, at: a.row.at, paused: !!a.row.paused, def: a.def, load, next: due };
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
