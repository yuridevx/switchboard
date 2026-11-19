// Фабрика: тикеты флота. Тикет — единица работы проекта: исполнитель, шаг, состояние и заметки с вердиктами; записи — объект на проект.
// Шаг отдаётся сессии запросом «дать работу» её машине. Кончает шаг вердикт — сессии, которая его ведёт, человека или машины этой сессии — либо срок.
// Сама Фабрика ничего не чинит и не повторяет: отказ машины, второй возврат и вышедший срок ставят тикет в «стоп» с причиной.
import { CALL_MS, errFields, kindOf, machineOf, newId, type Project, Refusal, sessionName, termMs, type Ticket, type TicketNote, type TicketState, type Verdict, within } from "@sb/protocol";
import type { Ctx, Env, Module, Outside } from "../../env.ts";
import { type Op, records } from "../../records.ts";
import { line } from "../analytics/contract.ts";
import { drop, on, set } from "../clock/contract.ts";

const NAME = "factory";
/** Адрес службы: от него сессия получает шаг. */
const FROM = ".factory";
/** Вид правила часов: срок шага в работе. */
const TERM = "factory.term";
/** Возвратов на одном шаге: второй ставит тикет в «стоп». */
const RETURNS = 2;
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS tickets (n INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, text TEXT NOT NULL, dest TEXT, step INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL, session TEXT, by TEXT NOT NULL, why TEXT, key TEXT, tag TEXT, pr TEXT, returns INTEGER NOT NULL DEFAULT 0,
    since INTEGER NOT NULL, moved INTEGER NOT NULL, term INTEGER, until INTEGER, dropped INTEGER NOT NULL DEFAULT 0)`,
  "CREATE INDEX IF NOT EXISTS tickets_state ON tickets (state, dest)",
  "CREATE TABLE IF NOT EXISTS notes (n INTEGER NOT NULL, at INTEGER NOT NULL, by TEXT NOT NULL, verdict TEXT, text TEXT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS notes_n ON notes (n, at)",
];
const db = (env: Env, fleet: string, project: string) => records(env, fleet, NAME, SCHEMA, project);

type Stored = {
  n: number; title: string; text: string; dest: string | null; step: number; state: TicketState; session: string | null; by: string; why: string | null;
  key: string | null; tag: string | null; pr: string | null; returns: number; since: number; moved: number; term: number | null; until: number | null; dropped: number;
};

const idOf = (project: string, n: number) => `${project}-${n}`;
/** Номер тикета → проект и порядковое число. */
function parse(id: string): { project: string; n: number } {
  const cut = id.lastIndexOf("-");
  const n = Number(id.slice(cut + 1));
  if (cut < 1 || !Number.isInteger(n) || n < 1) throw new Refusal("no_ticket", `${id} — не номер тикета: номер вида проект-число`);
  return { project: id.slice(0, cut), n };
}
const timer = (project: string, n: number) => `${NAME}/${project}/${n}`;

const ticket = (project: string, s: Stored, notes?: TicketNote[]): Ticket => ({
  id: idOf(project, s.n), project, title: s.title, text: s.text, step: s.step, state: s.state, by: s.by, returns: s.returns, since: s.since, moved: s.moved,
  ...(s.dest ? { to: s.dest } : {}), ...(s.session ? { session: s.session } : {}), ...(s.why ? { why: s.why } : {}), ...(s.key ? { key: s.key } : {}), ...(s.tag ? { tag: s.tag } : {}),
  ...(s.pr ? { pr: s.pr } : {}), ...(s.until ? { until: s.until } : {}), ...(s.dropped ? { dropped: true } : {}), ...(notes ? { notes } : {}),
});

/** Проект есть, и пришедший — его участник или админ флота. */
async function member(ctx: Ctx, project: string): Promise<void> {
  const r = await ctx.platform.fleetCall(ctx.fleet, ctx.who, { type: "people.list", id: newId("r"), trace: ctx.trace });
  if (!r.ok) throw new Refusal(r.error ?? "offline", r.why ?? "объект флота не назвал проекты");
  const projects = (r.result as { projects?: Project[] }).projects ?? [];
  const p = projects.find((x) => x.id === project);
  if (!p) throw new Refusal("no_project", `проекта ${project} нет: ${projects.map((x) => `${x.id} — ${x.name}`).join(", ") || "проектов нет"}`);
  if (!ctx.who.admin && !p.members.includes(ctx.who.person)) throw new Refusal("forbidden", `проект ${project} — не ваш`);
}

/** Проект запроса: названный или проект сессии, которая пришла. */
async function projectOf(ctx: Ctx, named?: string): Promise<string> {
  let project = named;
  if (!project && kindOf(ctx.who.addr) === "session") project = (await ctx.platform.sessions(ctx.fleet)).find((s) => s.callsign === ctx.who.addr)?.spec.project;
  if (!project) throw new Refusal("no_project", "назовите проект: project — номер из people_list");
  await member(ctx, project);
  return project;
}

/** Строка истории флота о движении тикета: машина — та, где сессия шага или исполнитель. Не записалась — строка журнала службы. */
function trail(env: Env, w: Outside, fleet: string, project: string, s: Stored, move: string, by: string, text = ""): Promise<void> {
  const who = s.session ?? s.dest ?? by;
  return line(env, w.fetch, fleet, {
    file: NAME, msg: "ticket", kind: move, machine: machineOf(who) ?? "", session: kindOf(who) === "session" ? who : "", text: text.slice(0, 500),
    data: { ticket: idOf(project, s.n), project, state: s.state, step: s.step, by, ...(s.dest ? { to: s.dest } : {}) },
  }).catch((e: unknown) => w.log.warn("строка истории о тикете не записалась", { module: NAME, fleet, ...errFields(e) }));
}

/** Тикет в «стоп» с причиной — если он ещё в том состоянии, из которого его ставят. */
async function stop(env: Env, w: Outside, fleet: string, project: string, n: number, from: TicketState, why: string, by: string, now = Date.now()): Promise<Stored | null> {
  const got = await db(env, fleet, project).batch([
    ["UPDATE tickets SET state = 'stop', why = ?1, moved = ?2, until = NULL WHERE n = ?3 AND state = ?4 RETURNING *", why, now, n, from],
    ["INSERT INTO notes (n, at, by, verdict, text) SELECT ?1, ?2, ?3, 'stop', ?4 WHERE changes() > 0", n, now, by, why],
  ]);
  const s = (got[0]![0] as unknown as Stored | undefined) ?? null;
  if (s) await trail(env, w, fleet, project, s, "stop", by, why);
  return s;
}

/** Текст шага для сессии: что сделать, замечание возврата и чем шаг кончается. В тексте тикета {id} — его номер. */
function body(id: string, s: Stored, back?: string): string {
  return [
    `Тикет ${id}: ${s.title}`,
    ...(s.text ? ["", s.text.replaceAll("{id}", id)] : []),
    ...(back ? ["", `Вернули с замечанием: ${back}`] : []),
    "",
    `Шаг кончается вердиктом — инструмент ticket_set: {"ticket":"${id}","verdict":"done","note":"что сделано"}. Вернуть с замечанием — verdict "back"; нужен человек — verdict "stop" с вопросом в note.`,
  ].join("\n");
}

/** Отдать взятый тикет сессии: запрос «дать работу» её машине и срок шага на часах. Машина отказала — «стоп» с её словами. */
async function give(env: Env, w: Outside, fleet: string, project: string, s: Stored, trace: string): Promise<void> {
  const id = idOf(project, s.n);
  const d = db(env, fleet, project);
  const back = s.returns ? (await d.first<{ text: string }>("SELECT text FROM notes WHERE n = ? AND verdict = 'back' ORDER BY at DESC LIMIT 1", s.n))?.text : undefined;
  let why = "";
  try {
    const r = await within(
      w.platform.deliver(fleet, { type: "work.give", id: newId("r"), trace, from: FROM, to: "@" + machineOf(s.session!), name: sessionName(s.session!), ticket: id, text: body(id, s, back) }),
      CALL_MS, "машина не ответила",
    );
    if (r && !r.ok) why = `${r.error}${r.why ? `: ${r.why}` : ""}`;
  } catch (e) {
    why = e instanceof Refusal ? `${e.word}${e.why ? `: ${e.why}` : ""}` : errFields(e).why ?? String(e);
  }
  if (why) return void (await stop(env, w, fleet, project, s.n, "work", `работа не дана: ${why}`, FROM));
  await set(env, fleet, { id: timer(project, s.n), kind: TERM, at: s.until!, input: { project, n: s.n, step: s.step } });
  await trail(env, w, fleet, project, s, "given", FROM);
}

/** Раздать готовое. У сессии-исполнителя один тикет в работе; место берётся одной записью — два одновременных события не запустят тикет дважды. */
export async function run(env: Env, w: Outside, fleet: string, project: string, trace: string, now = Date.now()): Promise<void> {
  const taken = (
    await db(env, fleet, project).batch([
      [
        `UPDATE tickets SET state = 'work', session = dest, moved = ?1, until = ?1 + term WHERE n IN (
           SELECT min(t.n) FROM tickets t WHERE t.state = 'ready' AND t.dest IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM tickets b WHERE b.state = 'work' AND b.session = t.dest) GROUP BY t.dest
         ) RETURNING *`,
        now,
      ],
    ])
  )[0] as unknown as Stored[];
  await Promise.all(taken.map((s) => give(env, w, fleet, project, s, trace)));
}

// срок шага вышел, а вердикта нет: «стоп»; тикет уже ушёл с этого шага — срок не про него
on(TERM, async (env, fleet, input, w) => {
  const { project, n, step } = input as { project: string; n: number; step: number };
  const got = await db(env, fleet, project).first<Stored>("SELECT * FROM tickets WHERE n = ? AND state = 'work' AND step = ? AND until <= ?", n, step, w.now);
  if (!got) return;
  if (await stop(env, w, fleet, project, n, "work", "срок вышел", FROM, w.now)) await run(env, w, fleet, project, newId("t"), w.now);
});

const outside = (ctx: Ctx): Outside => ({ platform: ctx.platform, fetch: ctx.fetch, log: ctx.log });

export const factory: Module = {
  name: NAME,
  handlers: {
    async "ticket.new"(i: { project?: string; to?: string; title: string; text?: string; tag?: string; key?: string; for?: string }, ctx) {
      const project = await projectOf(ctx, i.project);
      if (i.to !== undefined) {
        if (kindOf(i.to) !== "session") throw new Refusal("bad_input", `исполнитель ${i.to}: нужен позывной сессии вида site@laptop`);
        if (!i.for) throw new Refusal("no_term", "тикету сессии нужен срок работы: for — 20m, 2h, 1d");
        if (!(await ctx.platform.sessions(ctx.fleet)).some((s) => s.callsign === i.to)) throw new Refusal("no_session", `сессии ${i.to} нет во флоте`);
      }
      const now = Date.now();
      const [made] = await db(ctx.env, ctx.fleet, project).all<Stored>(
        "INSERT INTO tickets (title, text, dest, state, by, key, tag, since, moved, term) VALUES (?, ?, ?, 'ready', ?, ?, ?, ?, ?, ?) RETURNING *",
        i.title, i.text ?? "", i.to ?? null, ctx.who.addr, i.key ?? null, i.tag ?? null, now, now, i.for ? termMs(i.for) : null,
      );
      const w = outside(ctx);
      ctx.after(trail(ctx.env, w, ctx.fleet, project, made!, "new", ctx.who.addr, i.title).then(() => run(ctx.env, w, ctx.fleet, project, ctx.trace)));
      return { id: idOf(project, made!.n) };
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
        return { tickets: [ticket(project, s, notes)] };
      }
      const project = await projectOf(ctx, i.project);
      const where = ["1 = 1"];
      const params: (string | number)[] = [];
      if (i.state) (where.push("state = ?"), params.push(i.state));
      if (i.to) (where.push("dest = ?"), params.push(i.to));
      if (i.session) (where.push("session = ?"), params.push(i.session));
      const rows = await d(project).all<Stored>(`SELECT * FROM tickets WHERE ${where.join(" AND ")} ORDER BY n DESC LIMIT 500`, ...params);
      return { tickets: rows.map((s) => ticket(project, s)) };
    },

    async "ticket.set"(i: { ticket: string; verdict?: Verdict; note?: string; to?: string; for?: string; resume?: boolean; drop?: boolean; pr?: string }, ctx) {
      const { project, n } = parse(i.ticket);
      await member(ctx, project);
      const d = db(ctx.env, ctx.fleet, project);
      const was = await d.first<Stored>("SELECT * FROM tickets WHERE n = ?", n);
      if (!was) throw new Refusal("no_ticket", `тикета ${i.ticket} нет`);
      if ([i.verdict, i.resume, i.drop].filter(Boolean).length > 1) throw new Refusal("bad_input", "одно из трёх: verdict, resume или drop");
      const by = ctx.who.addr;
      const now = Date.now();
      const w = outside(ctx);
      const note = i.note ?? "";
      /** Правка тикета, если он всё ещё в том же состоянии и на том же шаге; заметка — той же пачкой. Тикет уже ушёл — отказ. */
      const move = async (sets: string, params: (string | number | null)[], verdict: Verdict | null, text: string): Promise<Stored> => {
        const ops: Op[] = [[`UPDATE tickets SET ${sets}, moved = ? WHERE n = ? AND state = ? AND step = ? RETURNING *`, ...params, now, n, was.state, was.step]];
        if (verdict || text) ops.push(["INSERT INTO notes (n, at, by, verdict, text) SELECT ?, ?, ?, ?, ? WHERE changes() > 0", n, now, by, verdict, text]);
        const s = (await d.batch(ops))[0]![0] as unknown as Stored | undefined;
        if (!s) throw new Refusal("bad_state", `тикет ${i.ticket} уже изменён: прочитайте его заново`);
        return s;
      };
      let now_: Stored;
      let word: string;
      if (i.verdict) {
        // вердикт шагу в работе или ожидании: сессия — только та, что ведёт шаг; машина — шагу своей сессии; человек — любому
        if (was.state !== "work" && was.state !== "wait") throw new Refusal("bad_state", `тикет ${i.ticket} — ${was.state}: вердикт дают шагу в работе или ожидании`);
        const kind = kindOf(by);
        if (kind === "session" && was.session !== by) throw new Refusal("not_yours", `шаг тикета ${i.ticket} ведёт ${was.session ?? "не сессия"}`);
        if (kind === "machine" && machineOf(was.session ?? "") !== machineOf(by)) throw new Refusal("not_yours", `шаг тикета ${i.ticket} ведёт сессия другой машины`);
        if (i.verdict === "done") now_ = await move("state = 'done', until = NULL, why = NULL, returns = 0" + (i.pr ? ", pr = ?" : ""), i.pr ? [i.pr] : [], "done", note);
        else if (i.verdict === "stop") now_ = await move("state = 'stop', until = NULL, why = ?", [note || "нужен человек"], "stop", note);
        else if (was.returns + 1 >= RETURNS) now_ = await move("state = 'stop', until = NULL, why = 'второй возврат', returns = returns + 1", [], "back", note);
        else now_ = await move("state = 'ready', session = NULL, until = NULL, step = max(step - 1, 0), returns = returns + 1", [], "back", note);
        word = now_.state === "stop" && i.verdict === "back" ? "stop" : i.verdict;
      } else if (i.resume) {
        if (was.state !== "stop") throw new Refusal("bad_state", `тикет ${i.ticket} — ${was.state}: в очередь возвращают вставший`);
        now_ = await move("state = 'ready', session = NULL, why = NULL, returns = 0", [], null, note || "возвращён в очередь");
        word = "resume";
      } else if (i.drop) {
        if (was.state === "done") throw new Refusal("bad_state", `тикет ${i.ticket} уже закрыт`);
        now_ = await move("state = 'done', until = NULL, dropped = 1", [], null, note || "снят");
        word = "drop";
      } else {
        // правка без вердикта: исполнитель, срок, PR, заметка
        if (i.to !== undefined && was.state === "work") throw new Refusal("bad_state", `тикет ${i.ticket} в работе: исполнителя меняют у тикета в очереди или вставшего`);
        if (i.to !== undefined && kindOf(i.to) !== "session") throw new Refusal("bad_input", `исполнитель ${i.to}: нужен позывной сессии вида site@laptop`);
        if (i.to !== undefined && !(i.for || was.term)) throw new Refusal("no_term", "тикету сессии нужен срок работы: for — 20m, 2h, 1d");
        const sets: string[] = [];
        const params: (string | number | null)[] = [];
        if (i.to !== undefined) (sets.push("dest = ?"), params.push(i.to));
        if (i.for) (sets.push("term = ?"), params.push(termMs(i.for)));
        if (i.pr) (sets.push("pr = ?"), params.push(i.pr));
        if (!sets.length && !note) throw new Refusal("bad_input", "нечего менять: назовите verdict, resume, drop, to, for, pr или note");
        now_ = await move(sets.length ? sets.join(", ") : "n = n", params, null, note);
        word = i.to !== undefined ? "assign" : "note";
      }
      // шаг ушёл из работы — его срок с часов снят
      if (was.state === "work" && now_.state !== "work") await drop(ctx.env, ctx.fleet, { id: timer(project, n) });
      ctx.after(trail(ctx.env, w, ctx.fleet, project, now_, word, by, note).then(() => run(ctx.env, w, ctx.fleet, project, ctx.trace)));
      return { id: i.ticket, state: now_.state, step: now_.step };
    },
  },
};
