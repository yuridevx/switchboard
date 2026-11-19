// Договор «Фабрики»: тикет — единица работы флота; шаг тикета кончается вердиктом; служба отдаёт шаг сессии запросом «дать работу».
// Определение проекта — файл factory.json в репозитории ролей: посты, конвейеры, потолки и сроки.
import { Callsign, MachineAddr, Name, Person, request, z } from "../define.ts";
import { Spec } from "./session.ts";

/** Адрес службы «Фабрика»: от него сессия получает шаг тикета. */
export const FACTORY = ".factory";
/** Имя файла определения в корне репозитория ролей — одно для всех проектов. */
export const FACTORY_FILE = "factory.json";

/** Вердикт шага: done — сдал, тикет идёт дальше; back — вернул назад с замечанием; stop — нужен человек. */
export const Verdict = z.enum(["done", "back", "stop"]);
export type Verdict = z.infer<typeof Verdict>;
/** Состояние тикета: ready — в очереди (без исполнителя — бэклог); work — шаг у сессии; wait — ждёт человека или события; stop — встал с причиной; done — закрыт. */
export const TicketState = z.enum(["ready", "work", "wait", "stop", "done"]);
export type TicketState = z.infer<typeof TicketState>;
/** Срок словами: число и единица — s, m, h или d. */
export const Term = z.string().regex(/^[1-9]\d*[smhd]$/, "срок вида 90s, 20m, 2h или 3d");
const UNIT: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
/** Срок в миллисекундах. */
export const termMs = (t: string): number => Number(t.slice(0, -1)) * UNIT[t.at(-1)!]!;

/* ===== Определение проекта ===== */

/** Проверка-скрипт: команда и её предел. Код выхода 0 — хорошо; иначе вывод идёт в работу. */
export const Check = z.strictObject({ run: z.string().min(1), for: Term });
export type Check = z.infer<typeof Check>;
/** Шаг конвейера: имя и ровно один исполнитель — сессия (session: new — свежая, same — та же, что на прошлом шаге сессии), пост (post; {tag} — метка тикета),
 *  человек (human) или событие (wait). do — что сделать: текст сессии, {id} — номер тикета. Срок (for) шага сессии — свой, иначе конвейера или поста. */
export const StepDef = z.strictObject({
  name: z.string().min(1),
  session: z.enum(["new", "same"]).optional(), post: z.string().min(1).optional(), human: z.literal(true).optional(), wait: z.string().min(1).optional(),
  do: z.string().optional(), check: Check.optional(), for: Term.optional(),
  /** свежей сессии — свои провайдер, модель и роль вместо заданных конвейером */
  key: z.string().optional(), model: z.string().optional(), pieces: z.array(z.string()).optional(),
});
export type StepDef = z.infer<typeof StepDef>;
/** Конвейер: потолок — сколько шагов с сессиями идёт сразу; где работать (машины, папка: {id} — номер тикета, {tag} — метка), с чем и шаги по порядку. */
export const LineDef = z.strictObject({
  title: z.string().optional(), limit: z.number().int().min(1), for: Term.optional(), at: z.array(MachineAddr).min(1), cwd: z.string().min(1),
  key: z.string().optional(), model: z.string().optional(), pieces: z.array(z.string()).optional(), steps: z.array(StepDef).min(1),
});
export type LineDef = z.infer<typeof LineDef>;
/** Пост — именная постоянная сессия: машина, папка, провайдер, модель, роль и срок одного тикета. */
export const PostDef = z.strictObject({ title: z.string().optional(), at: MachineAddr, cwd: z.string().min(1), key: z.string().min(1), model: z.string().min(1), pieces: z.array(z.string()).optional(), for: Term });
export type PostDef = z.infer<typeof PostDef>;
/** Имя конвейера — слово исполнителя тикета: без пробелов и без @, чтобы не спутать с позывным. */
const LineName = z.string().regex(/^[^\s@]+$/, "имя конвейера — одно слово без @");
export const FactoryDef = z.strictObject({
  project: Name,
  /** потолок проекта: сколько шагов идёт сразу по всем конвейерам */
  limit: z.number().int().min(1),
  /** кого звать, когда тикет ждёт человека или встал */
  call: z.array(Person).optional(),
  posts: z.record(Name, PostDef).default({}),
  lines: z.record(LineName, LineDef).default({}),
});
export type FactoryDef = z.infer<typeof FactoryDef>;

/* ===== Тикет ===== */

export const TicketNote = z.object({ at: z.number(), by: z.string(), verdict: Verdict.optional(), text: z.string() });
export type TicketNote = z.infer<typeof TicketNote>;
export const Ticket = z.object({
  /** номер: проект и порядковое число, poe2-41 */
  id: z.string(), project: z.string(), title: z.string(), text: z.string(),
  /** исполнитель: конвейер, пост или позывной сессии; нет — тикет в бэклоге */
  to: z.string().optional(),
  /** номер шага конвейера с нуля; у поста и сессии — 0 */
  step: z.number(), state: TicketState,
  /** сессия, которая ведёт шаг */
  session: Callsign.optional(),
  /** кто создал: человек, сессия или машина */
  by: z.string(),
  /** причина у stop */
  why: z.string().optional(),
  key: z.string().optional(), tag: z.string().optional(), pr: z.string().optional(),
  /** возвратов на нынешнем шаге */
  returns: z.number(),
  since: z.number(), moved: z.number(),
  /** срок шага в работе или ожидании, мс */
  until: z.number().optional(),
  /** закрыт без работы */
  dropped: z.boolean().optional(),
  /** проверка шага в работе: её запускает машина сессии перед вердиктом «сдал» */
  check: Check.optional(),
  /** заметки с вердиктами — у тикета, названного по номеру */
  notes: z.array(TicketNote).optional(),
});
export type Ticket = z.infer<typeof Ticket>;

export const ticketNew = request("ticket.new", {
  owner: "factory", target: "service",
  tool: "Создать тикет — единицу работы с номером, исполнителем и вердиктом. Бери, чтобы дать задачу, которая не потеряется: остановленную сессию тикет поднимет сам, а исход вернётся вердиктом. to — исполнитель: конвейер или пост проекта (имена — factory_get) либо позывной сессии; нет — тикет ляжет в бэклог. for — срок работы: 20m, 2h, 1d — нужен только исполнителю-сессии, у конвейера и поста срок свой. title и text — что сделать и что считать готовым; tag — метка, по которой шаг конвейера выбирает пост; project — номер проекта (сессии не нужен: возьмётся её проект). Ответ: id — номер тикета. Отказы: no_project, no_dest (нет такого исполнителя), no_term (не назван срок), no_session.",
  example: { to: "coder-move@laptop", for: "2h", title: "Обход не останавливается у поля", text: "Готово: эталон остановки зелёный." },
  input: z.object({ project: z.string().optional(), to: z.string().optional(), title: z.string().min(1), text: z.string().optional(), tag: z.string().optional(), key: z.string().optional(), for: Term.optional() }),
  output: z.object({ id: z.string() }),
});

export const ticketList = request("ticket.list", {
  owner: "factory", target: "service",
  tool: "Тикеты проекта. Бери, чтобы увидеть бэклог, работу в ходу и вставшее. ticket — один тикет по номеру, с заметками и вердиктами; state — ready (очередь и бэклог), work, wait, stop, done; to — исполнитель; session — кто ведёт шаг; project — номер проекта (сессии не нужен). Ответ: tickets, новые первыми; у stop — why.",
  example: { state: "stop" }, reads: true,
  input: z.object({ project: z.string().optional(), ticket: z.string().optional(), to: z.string().optional(), state: TicketState.optional(), session: Callsign.optional() }),
  output: z.object({ tickets: z.array(Ticket) }),
});

export const ticketSet = request("ticket.set", {
  owner: "factory", target: "service",
  tool: "Сдать шаг тикета или изменить тикет. Шаг кончается вердиктом: verdict done — сделано; back — вернуть назад с замечанием; stop — нужен человек. note — заметка к вердикту: что сделано, замечание или вопрос. Вердикт шагу в работе даёт только сессия, которая его ведёт, или человек. Человеку и менеджеру: to — назначить исполнителя; resume: true — вернуть вставший тикет в очередь; drop: true — снять без работы; pr — номер PR вида owner/repo#12. Отказы: not_yours (шаг ведёт другая сессия), no_ticket, bad_state.",
  example: { ticket: "poe2-41", verdict: "done", note: "3 среза, эталоны 12 из 12" },
  input: z.object({ ticket: z.string(), verdict: Verdict.optional(), note: z.string().optional(), to: z.string().optional(), for: Term.optional(), resume: z.boolean().optional(), drop: z.boolean().optional(), pr: z.string().optional() }),
  output: z.object({ id: z.string(), state: TicketState, step: z.number() }),
});

/* ===== Определение: применить, прочитать, поставить на паузу ===== */

/** Применённое определение проекта: откуда взято и что сейчас идёт. */
export const FactoryState = z.object({
  project: z.string(), repo: z.string(), commit: z.string(), at: z.number(), paused: z.boolean(), def: FactoryDef,
  /** загрузка: шагов в работе у проекта и по конвейерам; ready — сколько ждёт места */
  load: z.object({ work: z.number(), lines: z.record(z.string(), z.object({ work: z.number(), ready: z.number() })) }),
});
export type FactoryState = z.infer<typeof FactoryState>;

export const factoryApply = request("factory.apply", {
  owner: "factory", target: "service",
  tool: "Применить определение проекта: службы читают factory.json из корня репозитория ролей, проверяют файл целиком и применяют. Бери после коммита и push правки определения. project — номер проекта; repo — репозиторий вида владелец/имя, он должен стоять в настройке флота profiles.repos. Ошибка в файле — отказ bad_factory с путём к строке, действует прежнее определение. Ответ: commit, число постов и конвейеров, opened — посты, открытые этим применением, failed — посты, которые открыть не удалось, с причиной.",
  example: { project: "poe2", repo: "home-plab/poe2-v2" },
  input: z.object({ project: z.string(), repo: z.string() }),
  output: z.object({ commit: z.string(), posts: z.number(), lines: z.number(), opened: z.array(Callsign), failed: z.array(z.object({ post: z.string(), why: z.string() })) }),
});

export const factoryGet = request("factory.get", {
  owner: "factory", target: "service",
  tool: "Фабрика проекта: применённое определение (посты, конвейеры с шагами, потолки, сроки), коммит, пауза и загрузка конвейеров. Бери, чтобы узнать имена конвейеров и постов для ticket_new и что сейчас идёт. project — номер проекта (сессии не нужен); без проекта у человека — список проектов, у которых определение применено. Отказ: no_factory — у проекта определения нет.",
  example: {}, reads: true,
  input: z.object({ project: z.string().optional() }),
  output: z.object({ factory: FactoryState.optional(), projects: z.array(z.object({ project: z.string(), repo: z.string(), commit: z.string(), at: z.number(), paused: z.boolean() })).optional() }),
});

export const factoryPause = request("factory.pause", {
  owner: "factory", target: "service",
  tool: "Поставить фабрику проекта на паузу или снять с неё. На паузе новые шаги не запускаются; идущие шаги сдаются как обычно; тикеты и очередь остаются на месте. on: true — пауза, false — снять. project — номер проекта (сессии не нужен).",
  example: { on: true },
  input: z.object({ project: z.string().optional(), on: z.boolean() }),
  output: z.object({ paused: z.boolean() }),
});

/* ===== Дать работу ===== */

/** Дать работу сессии машины: сессии с таким именем нет — открыть по документу spec; остановлена — поднять; затем ввод тегом вида ticket.
 *  Зовёт только служба «Фабрика». on — имя правила входа: текст события — данные, а не команды. */
export const workGive = request("work.give", {
  owner: "host-work", target: "machine",
  input: z.object({ to: MachineAddr, name: Name, spec: Spec.optional(), ticket: z.string(), step: z.string().optional(), on: z.string().optional(), key: z.string().optional(), text: z.string() }),
  output: z.object({ callsign: Callsign }),
});
