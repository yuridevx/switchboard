// Договор «Фабрики»: тикет — единица работы флота; работа кончается вердиктом; служба отдаёт тикет сессии запросом «дать работу».
// Определение проекта — файл factory.json в репозитории ролей: посты и правила входа — то, что заводит тикеты само.
import { Callsign, MachineAddr, Name, Person, request, z } from "../define.ts";
import { CALL_MS } from "../frame.ts";
import { FileIn, Spec } from "./session.ts";

/** Адрес службы «Фабрика»: от него сессия получает тикет. */
export const FACTORY = ".factory";
/** Имя файла определения — одно для всех проектов: в корне репозитория ролей или в папке кусочка. */
export const FACTORY_FILE = "factory.json";

/** Вердикт тикету в работе: done — сдал, тикет закрыт; back — вернул с замечанием; stop — нужен человек. */
export const Verdict = z.enum(["done", "back", "stop"]);
export type Verdict = z.infer<typeof Verdict>;
/** Состояние тикета: ready — в очереди (без исполнителя — бэклог); work — у сессии; wait — спит: ждёт названных тикетов или своего срока; stop — встал с причиной; done — закрыт. */
export const TicketState = z.enum(["ready", "work", "wait", "stop", "done"]);
export type TicketState = z.infer<typeof TicketState>;
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
/** Пост — очередь роли и её постоянные сессии: машина, папка, провайдер, модель, роль и срок одного тикета. size — сколько сессий берут
 *  тикеты из одной очереди (нет — одна); свободная берёт срочный, потом старший. check — проверка «сдал»: её запускает машина сессии
 *  перед вердиктом, {id} в команде — номер тикета. context — что с разговором сессии на границе тикетов: keep (нет — оно) — продолжается;
 *  thread — продолжается, пока у тикетов один предмет (key), перед другим начинается заново, а тикеты одного предмета идут одной сессии по
 *  очереди; fresh — заново перед каждым тикетом. givers — посты, чьи сессии вправе давать этому посту работу; нет — любой. */
export const Context = z.enum(["keep", "thread", "fresh"]);
export type Context = z.infer<typeof Context>;
export const PostDef = z.strictObject({
  title: z.string().optional(), at: MachineAddr, cwd: z.string().min(1), key: z.string().min(1), model: z.string().min(1), pieces: z.array(z.string()).optional(), for: Term,
  size: z.number().int().min(1).optional(), check: Check.optional(), context: Context.optional(), givers: z.array(Name).min(1).optional(),
});
/** Позывные сессий поста: первая зовётся именем поста, остальные — имя-2, имя-3. Правило одно: службы и экран берут имена отсюда. */
export const postSessions = (name: string, p: { at: string; size?: number }): string[] =>
  Array.from({ length: p.size ?? 1 }, (_, i) => `${i ? `${name}-${i + 1}` : name}@${p.at.slice(1)}`);
export type PostDef = z.infer<typeof PostDef>;
/** Пост, которому принадлежит сессия: имя и определение; сессия не из постов — undefined. */
export function postOf(posts: Record<string, PostDef>, callsign: string): { name: string; post: PostDef } | undefined {
  for (const [name, post] of Object.entries(posts)) if (postSessions(name, post).includes(callsign)) return { name, post };
  return undefined;
}
/** Предел проверки правила входа: она идёт одним запросом к машине, остаток предела запроса — на доставку и запись тикета. */
export const RULE_CHECK_MS = CALL_MS - 30_000;
/** Проверка правила входа: команда bash без модели на названной машине (cwd — папка, без неё домашняя). Код 0 — тихо; иначе вывод — находка. */
export const RuleCheck = z.strictObject({ at: MachineAddr, run: z.string().min(1), for: Term, cwd: z.string().min(1).optional() });
export type RuleCheck = z.infer<typeof RuleCheck>;
/** Правило входа — то, что заводит тикеты само. Вход у правила не больше чем один: срок — every («каждые 10m») или cron (строка расписания,
 *  tz — часовой пояс, без него UTC) — либо адрес с секретом (hook: true; адрес выдаёт hook_url). По имени зовётся любое правило — ticket_new {on}.
 *  У правила со сроком бывает проверка: тогда тикет заводит только её находка, без неё — каждый срок. to — пост;
 *  key — ключ события (нет — имя правила): пока тикет с этим правилом и ключом открыт, следующее событие дописывается в него заметкой. */
export const RuleDef = z.strictObject({
  name: Name, every: Term.optional(), cron: z.string().min(1).optional(), tz: z.string().min(1).optional(), check: RuleCheck.optional(), hook: z.literal(true).optional(),
  to: z.string().min(1), title: z.string().optional(), text: z.string().optional(), key: z.string().optional(),
});
export type RuleDef = z.infer<typeof RuleDef>;
/** Правила, которые зовёт по имени сама платформа. Машина — в проекте сессии, с которой случилось событие: account — вход аккаунта или ключа
 *  провайдера не принят (ключ события — имя аккаунта); model — ответила не та модель, что в документе сессии (ключ — позывной); правила у
 *  проекта нет — событие остаётся строкой журнала машины. Служба «Фабрика»: stop — тикет встал не по слову своей сессии и не по слову
 *  человека (ключ — номер тикета): его разбирает пост этого правила — надзиратель; правила нет — зовут людей проекта. */
export const MACHINE_RULES = { account: "account", model: "model", stop: "stop" } as const;
export const FactoryDef = z.strictObject({
  project: Name,
  /** кого звать, когда тикет встал */
  call: z.array(Person).optional(),
  posts: z.record(Name, PostDef).default({}),
  /** правила входа: что заводит тикеты само */
  on: z.array(RuleDef).default([]),
});
export type FactoryDef = z.infer<typeof FactoryDef>;

/* ===== Тикет ===== */

/** Что можно сделать с тикетом: verdict — дать вердикт; resume — вернуть вставший или спящий в очередь; drop — снять; assign — назначить исполнителя. */
export const TicketAct = z.enum(["verdict", "resume", "drop", "assign"]);
export type TicketAct = z.infer<typeof TicketAct>;
export const TicketNote = z.object({ at: z.number(), by: z.string(), verdict: Verdict.optional(), text: z.string() });
export type TicketNote = z.infer<typeof TicketNote>;
export const Ticket = z.object({
  /** номер: проект и порядковое число, poe2-41 */
  id: z.string(), project: z.string(), title: z.string(),
  /** текст — у тикета, названного по номеру: строка списка его не несёт */
  text: z.string().optional(),
  /** исполнитель: пост или позывной сессии; нет — тикет в бэклоге */
  to: z.string().optional(),
  state: TicketState,
  /** сессия, которая ведёт тикет */
  session: Callsign.optional(),
  /** срочный: в очереди стоит впереди старших */
  first: z.boolean().optional(),
  /** тикеты, итога которых он ждёт: спит, пока у каждого нет итога — сдан, снят или встал */
  after: z.array(z.string()).optional(),
  /** тикет, с шага которого этот заведён: его итог ляжет туда заметкой */
  parent: z.string().optional(),
  /** кто создал: человек, сессия или машина */
  by: z.string(),
  /** причина у stop */
  why: z.string().optional(),
  /** встал и ждёт человека: надзиратель (пост правила stop) им не занят. Правило знают службы, страница его не повторяет */
  human: z.boolean().optional(),
  key: z.string().optional(),
  /** правило входа, которое завело тикет */
  on: z.string().optional(),
  /** спит до этого момента, мс: рядом с after — предел ожидания */
  start: z.number().optional(),
  /** файлы тикета: содержимое в хранилище флота; сессии они встают в папку, как файлы сообщения */
  files: z.array(FileIn).optional(),
  /** возвратов */
  returns: z.number(),
  since: z.number(), moved: z.number(),
  /** срок работы, мс */
  until: z.number().optional(),
  /** закрыт без работы */
  dropped: z.boolean().optional(),
  /** проверка поста у тикета в работе: её запускает машина сессии перед вердиктом «сдал» */
  check: Check.optional(),
  /** заметки с вердиктами — у тикета, названного по номеру */
  notes: z.array(TicketNote).optional(),
  /** что с тикетом может сделать тот, кто спросил, — у тикета, названного по номеру: правило знают службы, страница его не повторяет */
  acts: z.array(TicketAct).optional(),
});
export type Ticket = z.infer<typeof Ticket>;

export const ticketNew = request("ticket.new", {
  owner: "factory", target: "service",
  tool: "Создать тикет — единицу работы с номером, исполнителем и вердиктом. Бери, чтобы дать задачу, которая не потеряется: остановленную сессию тикет поднимет сам, а исход вернётся вердиктом. to — исполнитель: пост проекта (имена — factory_get) либо позывной сессии; нет — тикет ляжет в бэклог. key — предмет тикета: место кода, тема; посту «по предмету» (context: thread в factory_get) он обязателен — тикеты одного предмета идут одной сессии по очереди и в одном разговоре, перед другим предметом разговор начинается заново. У поста бывают раздающие (givers в factory_get): работу ему дают только их сессии — остальным отказ not_giver, находку отдай раздающему. for — срок работы: 20m, 2h, 1d — нужен только исполнителю-сессии, у поста срок свой. after — номера тикетов, которых этот ждёт: он спит, пока у каждого нет итога (сдан, снят или встал), потом встаёт в очередь — так выдают дело «после того»; in — спать до срока: рядом с after это предел ожидания, будит первое. first: true — срочный: встанет в очереди впереди старших. Тикет, заведённый с твоего тикета в работе, помнит его: итог ляжет туда заметкой — опрашивать не нужно. title и text — что сделать и что считать готовым; files — файлы из хранилища флота (их кладёт file_send); project — номер проекта (сессии не нужен: возьмётся её проект). Событие правила входа — on: имя правила проекта (имена — factory_get), с ним только key, text и files: исполнитель и название — у правила; пока тикет с этим правилом и ключом открыт, событие ляжет в него заметкой. Ответ: id — номер тикета. Отказы: no_project, no_dest (нет такого исполнителя), no_term (не назван срок), no_session, no_rule (нет такого правила), no_ticket (нет тикета из after), not_giver (посту работу раздают другие — в отказе их имена), bad_input (посту «по предмету» не назван key).",
  example: { to: "coder-move@laptop", for: "2h", title: "Обход не останавливается у поля", text: "Готово: эталон остановки зелёный." },
  input: z.object({
    project: z.string().optional(), to: z.string().optional(), title: z.string().min(1).optional(), text: z.string().optional(), key: z.string().optional(),
    for: Term.optional(), in: Term.optional(), after: z.array(z.string()).min(1).max(20).optional(), first: z.boolean().optional(), on: z.string().optional(), files: z.array(FileIn).optional(),
  }),
  output: z.object({ id: z.string() }),
});

export const ticketList = request("ticket.list", {
  owner: "factory", target: "service",
  tool: "Тикеты проекта. Бери, чтобы увидеть бэклог, работу в ходу и вставшее. Список — короткие строки: номер, название, состояние, исполнитель, кто ведёт, кого ждёт; текст, заметки, вердикты и то, что с тикетом можешь сделать ты (acts), — у одного тикета по номеру: ticket. state — ready (очередь и бэклог), work, wait (спит), stop, done; to — исполнитель; session — кто ведёт; key — все тикеты одного предмета; project — номер проекта (сессии не нужен). Ответ: tickets, новые первыми; у stop — why и human: true, если тикет ждёт человека (надзиратель им не занят).",
  example: { state: "stop" }, reads: true,
  input: z.object({ project: z.string().optional(), ticket: z.string().optional(), to: z.string().optional(), state: TicketState.optional(), session: Callsign.optional(), key: z.string().optional() }),
  output: z.object({ tickets: z.array(Ticket) }),
});

export const ticketSet = request("ticket.set", {
  owner: "factory", target: "service",
  tool: "Сдать тикет или изменить его. Работа кончается вердиктом: verdict done — сделано; back — вернуть с замечанием; stop — нужен человек. note — заметка к вердикту: что сделано, замечание или вопрос. Вердикт тикету в работе даёт только сессия, которая его ведёт, или человек. Ждёшь чужого тикета — усыпи свой: after — номера тикетов; он вернётся тебе, когда у каждого будет итог (сдан, снят или встал), итог придёт заметкой. Ждёшь времени — in: срок (40m, 2h); рядом с after это предел ожидания, будит первое. Пока тикет спит, место свободно. Заметка спящий тикет не будит: её увидят при выдаче; разбудить сейчас — resume: true, можно вместе с note. Тикет не твой — передай: to — другой исполнитель, тикет и заметки те же. «Сдал» с заметкой, которой ты ещё не видела, один раз вернётся отказом unread с её текстом: учти и сдай снова. note без вердикта — заметка в тикет. first: true — сделать срочным: впереди старших в очереди; false — снять срочность. Человеку и менеджеру: to — назначить исполнителя тикету не в работе; resume: true — вернуть вставший или спящий тикет в очередь; drop: true — снять без работы. Отказы: not_yours (тикет ведёт другая сессия), no_ticket, bad_state, unread (к тикету пришли заметки), not_giver (to — пост, которому работу раздают другие).",
  example: { ticket: "poe2-41", verdict: "done", note: "3 среза, эталоны 12 из 12" },
  input: z.object({ ticket: z.string(), verdict: Verdict.optional(), note: z.string().optional(), to: z.string().optional(), for: Term.optional(), resume: z.boolean().optional(), drop: z.boolean().optional(), in: Term.optional(), after: z.array(z.string()).min(1).max(20).optional(), first: z.boolean().optional() }),
  output: z.object({ id: z.string(), state: TicketState }),
});

/* ===== Определение: применить, прочитать, поставить на паузу ===== */

/** Применённое определение проекта: откуда взято и что сейчас идёт. */
export const FactoryState = z.object({
  project: z.string(), repo: z.string(), commit: z.string(), at: z.number(), paused: z.boolean(), def: FactoryDef,
  /** очередь поста: work — тикетов в работе, ready — в очереди (спящие не в счёт), first — срочных среди них, oldest — сколько ждёт старший в очереди, мс */
  load: z.record(z.string(), z.object({ work: z.number(), ready: z.number(), first: z.number(), oldest: z.number().optional() })),
  /** ближайший срок правил входа по времени: имя правила → мс */
  next: z.record(z.string(), z.number()),
});
export type FactoryState = z.infer<typeof FactoryState>;

export const factoryApply = request("factory.apply", {
  owner: "factory", target: "service",
  tool: "Применить определение проекта: службы читают factory.json из репозитория ролей, проверяют файл целиком и применяют. Бери после коммита и push правки определения. project — номер проекта; repo — где лежит файл: репозиторий ролей вида владелец/имя (файл в корне) или кусочек в нём вида владелец/имя/папка (файл в папке кусочка — так один репозиторий ролей держит определения нескольких проектов); репозиторий должен стоять в настройке флота profiles.repos. Ошибка в файле — отказ bad_factory с путём к строке, действует прежнее определение. Ответ: commit, число постов и правил входа, opened — сессии постов, открытые этим применением, closed — сессии постов, которых в определении больше нет (пост убран или size уменьшен): они остановлены, их тикеты вернулись в очередь поста; failed — посты, которые открыть не удалось, с причиной.",
  example: { project: "poe2", repo: "home-plab/poe2-v2" },
  input: z.object({ project: z.string(), repo: z.string() }),
  output: z.object({ commit: z.string(), posts: z.number(), rules: z.number(), opened: z.array(Callsign), closed: z.array(Callsign), failed: z.array(z.object({ post: z.string(), why: z.string() })) }),
});

export const factoryGet = request("factory.get", {
  owner: "factory", target: "service",
  tool: "Фабрика проекта: применённое определение (посты, сроки, правила входа), коммит, пауза, очереди постов (load: в работе, в очереди, срочных, сколько ждёт старший) и ближайшие сроки правил (next). Бери, чтобы узнать имена постов для ticket_new и что сейчас идёт. project — номер проекта (сессии не нужен); без проекта у человека — список проектов, у которых определение применено. Отказ: no_factory — у проекта определения нет.",
  example: {}, reads: true,
  input: z.object({ project: z.string().optional() }),
  output: z.object({ factory: FactoryState.optional(), projects: z.array(z.object({ project: z.string(), repo: z.string(), commit: z.string(), at: z.number(), paused: z.boolean() })).optional() }),
});

export const factoryPause = request("factory.pause", {
  owner: "factory", target: "service",
  tool: "Поставить фабрику проекта на паузу или снять с неё. На паузе тикеты не выдаются и правила входа не срабатывают; тикеты в работе сдаются как обычно; тикеты и очередь остаются на месте. on: true — пауза, false — снять. project — номер проекта (сессии не нужен).",
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
 *  asker — кто дал задачу: ему идут вопросы сессии по этому тикету — создателю тикета (человеку или сессии); у тикета, заведённого правилом
 *  входа, — человеку из call проекта. */
export const workGive = request("work.give", {
  owner: "host-work", target: "machine",
  input: z.object({ to: MachineAddr, name: Name, spec: Spec.optional(), ticket: z.string(), on: z.string().optional(), key: z.string().optional(), text: z.string(), files: z.array(FileIn).optional(), asker: z.string().optional(), clear: z.boolean().optional() }),
  output: z.object({ callsign: Callsign }),
});
