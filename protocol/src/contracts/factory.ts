// Договор «Фабрики»: тикет — единица работы флота; шаг тикета кончается вердиктом; служба отдаёт шаг сессии запросом «дать работу».
// Определение проекта — файл factory.json в репозитории ролей: посты, конвейеры, потолки, сроки, репозитории и правила входа — то, что заводит тикеты само.
import { Callsign, MachineAddr, Name, Person, request, z } from "../define.ts";
import { CALL_MS } from "../frame.ts";
import { FileIn, Spec } from "./session.ts";

/** Адрес службы «Фабрика»: от него сессия получает шаг тикета. */
export const FACTORY = ".factory";
/** Имя файла определения — одно для всех проектов: в корне репозитория ролей или в папке кусочка. */
export const FACTORY_FILE = "factory.json";

/** Вердикт шага: done — сдал, тикет идёт дальше; back — вернул назад с замечанием; stop — нужен человек. */
export const Verdict = z.enum(["done", "back", "stop"]);
export type Verdict = z.infer<typeof Verdict>;
/** Состояние тикета: ready — в очереди (без исполнителя — бэклог); work — шаг у сессии; wait — ждёт человека или события; stop — встал с причиной; done — закрыт. */
export const TicketState = z.enum(["ready", "work", "wait", "stop", "done"]);
export type TicketState = z.infer<typeof TicketState>;
/** Событие шага-ожидания. pr.merged — шаг ждёт PR, который тикет назвал при сдаче прошлого шага: слит — «сдал», замечания ревью — «вернул»
 *  автору с текстом, закрыт без слияния — «стоп». */
export const WaitEvent = z.enum(["pr.merged"]);
export type WaitEvent = z.infer<typeof WaitEvent>;
/** Репозиторий GitHub: владелец/имя. */
export const RepoName = z.string().regex(/^[A-Za-z0-9-]+\/(?!\.\.?$)[\w.-]+$/, "репозиторий вида владелец/имя");
/** PR: репозиторий и номер — владелец/имя#12. */
export const PrRef = z.string().regex(/^[A-Za-z0-9-]+\/(?!\.\.?#)[\w.-]+#[1-9]\d*$/, "PR вида владелец/имя#12");
/** Срок словами: число и единица — s, m, h или d. */
export const Term = z.string().regex(/^[1-9]\d*[smhd]$/, "срок вида 90s, 20m, 2h или 3d");
const UNIT: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
/** Срок в миллисекундах. */
export const termMs = (t: string): number => Number(t.slice(0, -1)) * UNIT[t.at(-1)!]!;

/* ===== Определение проекта ===== */

/** Проверка-скрипт: команда bash (на Windows — Git Bash, как у инструмента Bash сессии) и её предел. Код выхода 0 — хорошо; иначе вывод идёт в работу. */
export const Check = z.strictObject({ run: z.string().min(1), for: Term });
export type Check = z.infer<typeof Check>;
/** Сколько знаков вывода проверки идёт в работу: конец вывода. */
const CHECK_OUT = 4000;
/** Запуск проверки — поля запроса shell.run машине to: команда bash, предел работы — срок проверки; cwd — папка, без неё домашняя. */
export function checkRun(c: { run: string; for: string }, to: string, cwd?: string) {
  const sec = termMs(c.for) / 1000;
  return { to, shell: "bash" as const, script: c.run, timeout: sec, wait: sec + 10, ...(cwd ? { cwd } : {}) };
}
/** Исход проверки по снимку её запуска: прошла — код выхода 0; иначе слова для работы — чем кончилась и конец вывода. */
export function checkOutcome(c: { run: string; for: string }, r: { state: string; code?: number; out?: string }): { good: true } | { good: false; text: string } {
  if (r.state === "done" && r.code === 0) return { good: true };
  const out = (r.out ?? "").slice(-CHECK_OUT).trim();
  return { good: false, text: `проверка «${c.run}» не прошла: ${r.state === "failed" ? `код ${r.code}` : r.state === "timeout" ? `не уложилась в ${c.for}` : r.state}${out ? "\n" + out : ""}` };
}
/** Шаг конвейера: имя и ровно один исполнитель — сессия (session: new — свежая, same — та же, что на прошлом шаге сессии), пост (post; {tag} — метка тикета),
 *  человек (human) или событие (wait). do — что сделать: текст сессии, {id} — номер тикета. Срок (for) шага сессии — свой, иначе конвейера или поста. */
export const StepDef = z.strictObject({
  name: z.string().min(1),
  session: z.enum(["new", "same"]).optional(), post: z.string().min(1).optional(), human: z.literal(true).optional(), wait: WaitEvent.optional(),
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
/** Предел проверки правила входа: она идёт одним запросом к машине, остаток предела запроса — на доставку и запись тикета. */
export const RULE_CHECK_MS = CALL_MS - 30_000;
/** Проверка правила входа: команда bash без модели на названной машине (cwd — папка, без неё домашняя). Код 0 — тихо; иначе вывод — находка. */
export const RuleCheck = z.strictObject({ at: MachineAddr, run: z.string().min(1), for: Term, cwd: z.string().min(1).optional() });
export type RuleCheck = z.infer<typeof RuleCheck>;
/** Правило входа — то, что заводит тикеты само. Вход у правила не больше чем один: срок — every («каждые 10m») или cron (строка расписания,
 *  tz — часовой пояс, без него UTC) — либо адрес с секретом (hook: true; адрес выдаёт hook_url). По имени зовётся любое правило — ticket_new {on}.
 *  У правила со сроком бывает проверка: тогда тикет заводит только её находка, без неё — каждый срок. to — конвейер или пост;
 *  key — ключ события (нет — имя правила): пока тикет с этим правилом и ключом открыт, следующее событие дописывается в него заметкой.
 *  github: "upstream.moved" — правило со сроком опрашивает чужой апстрим репозитория repo (имя из repos): голова его основной ветки сдвинулась —
 *  событие; тем же сроком спрашивается ответ по PR в апстриме, которых ждут тикеты проекта. */
export const RuleDef = z.strictObject({
  name: Name, every: Term.optional(), cron: z.string().min(1).optional(), tz: z.string().min(1).optional(), check: RuleCheck.optional(), hook: z.literal(true).optional(),
  github: z.literal("upstream.moved").optional(), repo: Name.optional(),
  to: z.string().min(1), title: z.string().optional(), text: z.string().optional(), key: z.string().optional(),
});
export type RuleDef = z.infer<typeof RuleDef>;
/** Правила, которые зовёт по имени сама машина — в проекте сессии, с которой случилось событие: account — вход аккаунта или ключа провайдера
 *  не принят (ключ события — имя аккаунта); model — ответила не та модель, что в документе сессии (ключ — позывной). Правила у проекта нет —
 *  событие остаётся строкой журнала машины. */
export const MACHINE_RULES = { account: "account", model: "model" } as const;
/** Репозиторий проекта: repo — свой, о его PR GitHub сообщает флоту событием с подписью (приложение GitHub флота должно быть к нему допущено).
 *  upstream — чужой оригинал, от которого он ответвлён: прав там нет, события оттуда не приходят — голову его ветки и наши PR в нём
 *  флот опрашивает по сроку правила с github: "upstream.moved". */
export const RepoDef = z.strictObject({ repo: RepoName, upstream: RepoName.optional() });
export type RepoDef = z.infer<typeof RepoDef>;
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
  /** репозитории проекта: по ним событие GitHub находит тикеты, которые ждут PR */
  repos: z.record(Name, RepoDef).default({}),
  /** правила входа: что заводит тикеты само */
  on: z.array(RuleDef).default([]),
});
export type FactoryDef = z.infer<typeof FactoryDef>;

/* ===== Тикет ===== */

/** Что можно сделать с тикетом: verdict — дать шагу вердикт; resume — вернуть вставший в очередь; drop — снять; assign — назначить исполнителя. */
export const TicketAct = z.enum(["verdict", "resume", "drop", "assign"]);
export type TicketAct = z.infer<typeof TicketAct>;
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
  /** правило входа, которое завело тикет */
  on: z.string().optional(),
  /** отложен: в очередь встанет не раньше этого момента, мс */
  start: z.number().optional(),
  /** файлы тикета: содержимое в хранилище флота; сессии шага они встают в папку, как файлы сообщения */
  files: z.array(FileIn).optional(),
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
  /** что с тикетом может сделать тот, кто спросил, — у тикета, названного по номеру: правило знают службы, страница его не повторяет */
  acts: z.array(TicketAct).optional(),
});
export type Ticket = z.infer<typeof Ticket>;

export const ticketNew = request("ticket.new", {
  owner: "factory", target: "service",
  tool: "Создать тикет — единицу работы с номером, исполнителем и вердиктом. Бери, чтобы дать задачу, которая не потеряется: остановленную сессию тикет поднимет сам, а исход вернётся вердиктом. to — исполнитель: конвейер или пост проекта (имена — factory_get) либо позывной сессии; нет — тикет ляжет в бэклог. for — срок работы: 20m, 2h, 1d — нужен только исполнителю-сессии, у конвейера и поста срок свой. in — отложить: тикет встанет в очередь через этот срок; так ставят дело на потом и самой себе — по своему позывному. title и text — что сделать и что считать готовым; tag — метка, по которой шаг конвейера выбирает пост; files — файлы из хранилища флота (их кладёт file_send); project — номер проекта (сессии не нужен: возьмётся её проект). Событие правила входа — on: имя правила проекта (имена — factory_get), с ним только key, text и files: исполнитель и название — у правила; пока тикет с этим правилом и ключом открыт, событие ляжет в него заметкой. Ответ: id — номер тикета. Отказы: no_project, no_dest (нет такого исполнителя), no_term (не назван срок), no_session, no_rule (нет такого правила).",
  example: { to: "coder-move@laptop", for: "2h", title: "Обход не останавливается у поля", text: "Готово: эталон остановки зелёный." },
  input: z.object({
    project: z.string().optional(), to: z.string().optional(), title: z.string().min(1).optional(), text: z.string().optional(), tag: z.string().optional(), key: z.string().optional(),
    for: Term.optional(), in: Term.optional(), on: z.string().optional(), files: z.array(FileIn).optional(),
  }),
  output: z.object({ id: z.string() }),
});

export const ticketList = request("ticket.list", {
  owner: "factory", target: "service",
  tool: "Тикеты проекта. Бери, чтобы увидеть бэклог, работу в ходу и вставшее. ticket — один тикет по номеру, с заметками, вердиктами и тем, что с ним можешь сделать ты (acts); state — ready (очередь и бэклог), work, wait, stop, done; to — исполнитель; session — кто ведёт шаг; project — номер проекта (сессии не нужен). Ответ: tickets, новые первыми; у stop — why.",
  example: { state: "stop" }, reads: true,
  input: z.object({ project: z.string().optional(), ticket: z.string().optional(), to: z.string().optional(), state: TicketState.optional(), session: Callsign.optional() }),
  output: z.object({ tickets: z.array(Ticket) }),
});

export const ticketSet = request("ticket.set", {
  owner: "factory", target: "service",
  tool: "Сдать шаг тикета или изменить тикет. Шаг кончается вердиктом: verdict done — сделано; back — вернуть назад с замечанием; stop — нужен человек. note — заметка к вердикту: что сделано, замечание или вопрос. Вердикт шагу в работе даёт только сессия, которая его ведёт, или человек. Человеку и менеджеру: to — назначить исполнителя; resume: true — вернуть вставший тикет в очередь; drop: true — снять без работы. pr — PR тикета вида владелец/имя#12: назови его, сдавая шаг, после которого конвейер ждёт слияния, — шаг-ожидание сдаст событие GitHub. Отказы: not_yours (шаг ведёт другая сессия), no_ticket, bad_state.",
  example: { ticket: "poe2-41", verdict: "done", note: "3 среза, эталоны 12 из 12" },
  input: z.object({ ticket: z.string(), verdict: Verdict.optional(), note: z.string().optional(), to: z.string().optional(), for: Term.optional(), resume: z.boolean().optional(), drop: z.boolean().optional(), pr: PrRef.optional() }),
  output: z.object({ id: z.string(), state: TicketState, step: z.number() }),
});

/* ===== Определение: применить, прочитать, поставить на паузу ===== */

/** Применённое определение проекта: откуда взято и что сейчас идёт. */
export const FactoryState = z.object({
  project: z.string(), repo: z.string(), commit: z.string(), at: z.number(), paused: z.boolean(), def: FactoryDef,
  /** загрузка: шагов в работе у проекта и по конвейерам; ready — сколько ждёт места */
  load: z.object({ work: z.number(), lines: z.record(z.string(), z.object({ work: z.number(), ready: z.number() })) }),
  /** ближайший срок правил входа по времени: имя правила → мс */
  next: z.record(z.string(), z.number()),
});
export type FactoryState = z.infer<typeof FactoryState>;

export const factoryApply = request("factory.apply", {
  owner: "factory", target: "service",
  tool: "Применить определение проекта: службы читают factory.json из репозитория ролей, проверяют файл целиком и применяют. Бери после коммита и push правки определения. project — номер проекта; repo — где лежит файл: репозиторий ролей вида владелец/имя (файл в корне) или кусочек в нём вида владелец/имя/папка (файл в папке кусочка — так один репозиторий ролей держит определения нескольких проектов); репозиторий должен стоять в настройке флота profiles.repos. Ошибка в файле — отказ bad_factory с путём к строке, действует прежнее определение. Ответ: commit, число постов, конвейеров и правил входа, opened — посты, открытые этим применением, failed — посты, которые открыть не удалось, с причиной.",
  example: { project: "poe2", repo: "home-plab/poe2-v2" },
  input: z.object({ project: z.string(), repo: z.string() }),
  output: z.object({ commit: z.string(), posts: z.number(), lines: z.number(), rules: z.number(), opened: z.array(Callsign), failed: z.array(z.object({ post: z.string(), why: z.string() })) }),
});

export const factoryGet = request("factory.get", {
  owner: "factory", target: "service",
  tool: "Фабрика проекта: применённое определение (посты, конвейеры с шагами, потолки, сроки, правила входа), коммит, пауза, загрузка конвейеров и ближайшие сроки правил (next). Бери, чтобы узнать имена конвейеров и постов для ticket_new и что сейчас идёт. project — номер проекта (сессии не нужен); без проекта у человека — список проектов, у которых определение применено. Отказ: no_factory — у проекта определения нет.",
  example: {}, reads: true,
  input: z.object({ project: z.string().optional() }),
  output: z.object({ factory: FactoryState.optional(), projects: z.array(z.object({ project: z.string(), repo: z.string(), commit: z.string(), at: z.number(), paused: z.boolean() })).optional() }),
});

export const factoryPause = request("factory.pause", {
  owner: "factory", target: "service",
  tool: "Поставить фабрику проекта на паузу или снять с неё. На паузе новые шаги не запускаются и правила входа не срабатывают; идущие шаги сдаются как обычно; тикеты и очередь остаются на месте. on: true — пауза, false — снять. project — номер проекта (сессии не нужен).",
  example: { on: true },
  input: z.object({ project: z.string().optional(), on: z.boolean() }),
  output: z.object({ paused: z.boolean() }),
});

/* ===== Вход по адресу с секретом ===== */

/** Адрес правила входа для событий снаружи: POST на него заводит тикет по правилу. Тело — текст события либо JSON {key, text, files: [{name, base64}]}.
 *  Секрет — 32 случайных байта в самом адресе; у служб хранится его хэш. Новый адрес правила отзывает прежний: на отозванный — 410, на чужой — 404. */
export const hookUrl = request("hook.url", {
  owner: "hooks", target: "service",
  tool: "Выдать адрес с секретом для правила входа проекта: внешняя система шлёт на него POST — событие идёт по правилу тикетом. name — имя правила с hook: true из определения (имена — factory_get); project — номер проекта (сессии не нужен). Тело POST — текст события или JSON {key, text, files: [{name, base64}]}; key склеивает повторы в один тикет. Адрес показывается один раз: у служб остаётся только хэш секрета. Новый адрес того же правила отзывает прежний. Отказ: no_rule — правила с адресом у проекта нет.",
  example: { name: "losses" },
  input: z.object({ project: z.string().optional(), name: z.string() }),
  output: z.object({ url: z.string() }),
});

/* ===== Дать работу ===== */

/** Дать работу сессии машины: сессии с таким именем нет — открыть по документу spec; остановлена — поднять; затем ввод тегом вида ticket.
 *  Зовёт только служба «Фабрика». on — имя правила входа: текст события — данные, а не команды. files — файлы тикета: встают в папку сессии.
 *  asker — кто дал задачу: ему идут вопросы сессии по этому шагу — создателю тикета (человеку или сессии); у тикета, заведённого правилом
 *  входа, — человеку из call проекта. */
export const workGive = request("work.give", {
  owner: "host-work", target: "machine",
  input: z.object({ to: MachineAddr, name: Name, spec: Spec.optional(), ticket: z.string(), step: z.string().optional(), on: z.string().optional(), key: z.string().optional(), text: z.string(), files: z.array(FileIn).optional(), asker: z.string().optional() }),
  output: z.object({ callsign: Callsign }),
});
