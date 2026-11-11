// Запросы машине: аккаунты, профили, точки, скрипты, инциденты, сама машина, keeper.
import { Callsign, Done, frame, KeeperAddr, MachineAddr, request, z } from "../define.ts";

const toMachine = z.object({ to: MachineAddr });

/* ===== Аккаунты (host-accounts) ===== */

/** at — когда окно замерено, мс: старый замер страница подписывает «от ЧЧ:ММ». */
export const Limit = z.object({ name: z.string(), used: z.number(), resets: z.number().optional(), at: z.number().optional() });
export const Account = z.object({
  id: z.string(),
  /** claude — вход Claude; key — ключ флота */
  kind: z.enum(["claude", "key"]),
  email: z.string().optional(),
  plan: z.string().optional(),
  /** доля лимитов 0..1 по окнам */
  limits: z.array(Limit).optional(),
  ok: z.boolean(),
  why: z.string().optional(),
  sessions: z.number().optional(),
  /** у ключа флота: провайдер, адрес, модель по умолчанию */
  provider: z.string().optional(),
  base: z.string().optional(),
  model: z.string().optional(),
  /** у ключа флота: alias-модели — имя для сессии → модель провайдера */
  models: z.record(z.string(), z.string()).optional(),
  /** когда лимиты замерены последний раз, мс */
  at: z.number().optional(),
  /** до какого времени действует вход Claude, мс */
  expires: z.number().optional(),
});
export type Account = z.infer<typeof Account>;

/** Модель очереди диктует выбор модели её сессий: fable — только Fable, очередь следит за общей неделей и лимитом Fable; other — все остальные модели, очередь следит только за общей неделей. */
export const SlotModel = z.enum(["fable", "other"]);
/** Очередь аккаунтов машины. model — модель очереди; order — порядок выбора; account — кто стоит сейчас; wait — все у порога: до какого времени очередь ждёт сброса, мс; sessions — сколько сессий идёт на очереди. */
export const Slot = z.object({ name: z.string(), model: SlotModel, order: z.array(z.string()), account: z.string().optional(), wait: z.number().optional(), sessions: z.number() });
export type Slot = z.infer<typeof Slot>;

export const accountList = request("account.list", {
  owner: "host-accounts", target: "machine", tool: "Аккаунты машины: входы Claude с лимитами, очереди аккаунтов (slots) и ключи флота.",
  input: toMachine, output: z.object({ accounts: z.array(Account), slots: z.array(Slot) }),
});
export const accountLogin = request("account.login", {
  owner: "host-accounts", target: "machine",
  input: toMachine, output: z.object({ login: z.string(), url: z.string() }),
});
export const accountCode = request("account.code", {
  owner: "host-accounts", target: "machine",
  input: z.object({ to: MachineAddr, login: z.string(), code: z.string() }), output: z.object({ account: Account }),
});
export const accountRemove = request("account.remove", {
  owner: "host-accounts", target: "machine",
  /** account — номер аккаунта из account.list. Поле id здесь не работает: это имя занято конвертом кадра. */
  input: z.object({ to: MachineAddr, id: z.string().optional(), account: z.string() }), output: Done,
});
/** Очередь аккаунтов: slot — её имя, order — порядок. Имени нет — очередь заводится; пустой order удаляет очередь без сессий. */
export const slotSet = request("slot.set", {
  owner: "host-accounts", target: "machine",
  tool: "Завести или изменить очередь аккаунтов на машине: slot — имя очереди, order — почты по порядку выбора, model — модель очереди (fable — сессии только на Fable, other — на остальных моделях; новая без model — fable); пустой order удаляет очередь без сессий.",
  input: z.object({ to: MachineAddr, slot: z.string(), model: SlotModel.optional(), order: z.array(z.string()) }), output: Done,
});
/** «Сменить сейчас»: поставить в очередь slot этот аккаунт; без account — следующий годный по порядку. */
export const slotSwap = request("slot.swap", {
  owner: "host-accounts", target: "machine",
  tool: "Сменить аккаунт очереди на машине сейчас: slot — имя очереди, account — почта аккаунта; без него — следующий годный по порядку.",
  input: z.object({ to: MachineAddr, slot: z.string(), account: z.string().optional() }), output: z.object({ account: z.string() }),
});
export const keyCheck = request("key.check", {
  owner: "host-proxy", target: "machine",
  input: z.object({ to: MachineAddr, name: z.string() }), output: z.object({ ok: z.boolean(), word: z.string() }),
});

/* ===== Правила прокси модели (host-proxy) ===== */

/** Где лежит текст запроса к модели: system — промпт, user, assistant, tool_result — ответ инструмента. */
export const RuleScope = z.enum(["system", "user", "assistant", "tool_result"]);
/** Правило замены текста запроса к модели — единственная форма: так оно хранится в ключе proxy.rules настроек флота и так его читает прокси.
 *  on — выключено, только если false; models — шаблоны имени модели (* — любые знаки), пусто — все; kind regex — регулярка RE2;
 *  unit — что править: совпадение, строку, абзац или весь блок; replacement — для replace ($1 и ${имя} — группы регулярки). */
export const ProxyRule = z.object({
  name: z.string().min(1),
  on: z.boolean().optional(),
  scopes: z.array(RuleScope).min(1),
  models: z.array(z.string()).optional(),
  kind: z.enum(["literal", "regex"]),
  icase: z.boolean().optional(),
  unit: z.enum(["match", "line", "paragraph", "block"]),
  action: z.enum(["replace", "delete"]),
  pattern: z.string().min(1),
  replacement: z.string().optional(),
});
export type ProxyRule = z.infer<typeof ProxyRule>;
/** Ключ настроек флота со списком правил. */
export const PROXY_RULES = "proxy.rules";
/** Проверка правил на тексте тем же движком, что у прокси: страница движок не повторяет. Без rules — правила флота как есть.
 *  flaws — ошибки правил по имени (негодная регулярка); hits — сколько раз сработало каждое. */
export const rulesTest = request("rules.test", {
  owner: "host-proxy", target: "machine",
  input: z.object({ to: MachineAddr, text: z.string(), scope: RuleScope.optional(), model: z.string().optional(), rules: z.array(ProxyRule.partial().extend({ name: z.string() })).optional() }),
  output: z.object({ after: z.string(), hits: z.record(z.string(), z.number()), flaws: z.record(z.string(), z.string()) }),
});

/* ===== Профили (host-profiles) ===== */

export const Piece = z.object({
  id: z.string(),
  repo: z.string(),
  title: z.string().optional(),
  about: z.string().optional(),
  /** что внутри: скилы, агенты, команды, хуки, серверы MCP, память, настройки */
  has: z.record(z.string(), z.number()).optional(),
  rev: z.string().optional(),
  ok: z.boolean(),
  why: z.string().optional(),
});
export type Piece = z.infer<typeof Piece>;

/** Клон репозитория кусочков на машине: wait — ещё не сводился; conflict — слияние ждёт сессию; error — шаг op не прошёл. */
export const RepoClone = z.object({
  repo: z.string(), state: z.enum(["ok", "wait", "conflict", "error"]), op: z.string().optional(), files: z.array(z.string()).optional(),
  error: z.string().optional(), dir: z.string().optional(), at: z.number().optional(),
});
export type RepoClone = z.infer<typeof RepoClone>;

export const profileList = request("profile.list", {
  owner: "host-profiles", target: "machine", tool: "Кусочки профиля на машине: репозитории с плагинами, настройками и памятью; repos — состояние клонов.",
  input: toMachine, output: z.object({ pieces: z.array(Piece), repos: z.array(RepoClone).optional() }),
});
/** «Свести сейчас»: все репозитории машины или только те, чьи кусочки у сессии session. */
export const profileSync = request("profile.sync", {
  owner: "host-profiles", target: "machine", tool: "Свести клоны кусочков на машине с GitHub сейчас: session — только репозитории кусочков этой сессии.",
  input: z.object({ to: MachineAddr, session: Callsign.optional() }), output: z.object({ repos: z.array(RepoClone) }),
});
const Won = z.object({ value: z.unknown(), from: z.string(), lost: z.array(z.object({ value: z.unknown(), from: z.string() })) });
/** Просмотр набора. items — плоский список; остальное — подробности: prompt — агент и стиль, tree — дерево наборов,
 *  settings — значение-победитель и проигравшие, files — файлы кусочка, other — файлы, которые Claude не подключит («потеряно»), near — добавка к промпту о памяти. */
export const profileView = request("profile.view", {
  owner: "host-profiles", target: "machine", tool: "Что получится у сессии с этим набором кусочков: скилы, агенты, серверы, настройки.",
  input: z.object({ to: MachineAddr, pieces: z.array(z.string()) }),
  output: z.object({
    items: z.array(z.object({ kind: z.string(), name: z.string(), piece: z.string(), path: z.string().optional(), about: z.string().optional() })),
    prompt: z.object({ agent: z.object({ name: z.string(), from: z.string(), path: z.string().optional() }).optional(), style: z.object({ name: z.string(), from: z.string(), found: z.boolean(), path: z.string().optional() }).optional(), append: z.string().optional() }).optional(),
    tree: z.array(z.unknown()).optional(),
    settings: z.record(z.string(), Won).optional(),
    files: z.record(z.string(), z.array(z.object({ path: z.string(), size: z.number() }).loose())).optional(),
    other: z.array(z.object({ from: z.string(), path: z.string() })).optional(),
  }),
});
export const profileFile = request("profile.file", {
  owner: "host-profiles", target: "machine",
  input: z.object({ to: MachineAddr, piece: z.string(), path: z.string() }), output: z.object({ text: z.string() }),
});

/* ===== Точки на машине (host-points) ===== */

export const pointsSave = request("points.save", {
  owner: "host-points", target: "session",
  tool: "Сохранить точку сессии в архив сейчас. stop — после точки остановить сессию; interrupt — прервать идущий ход перед точкой.",
  /** move — точка для переноса на другую машину: ход прерывается, сессия останавливается; ведущий пары с ведомым — отказ has_wing */
  input: z.object({ to: Callsign, label: z.string().optional(), stop: z.boolean().optional(), interrupt: z.boolean().optional(), move: z.boolean().optional() }),
  /** same — с прошлой точки ничего не изменилось: новая не записана, point — прежняя */
  output: z.object({ point: z.string(), same: z.boolean().optional() }),
});
/** Что будет с папкой при подъёме: nogit — точка без git, файлы папки не трогаются; empty — папки нет, будет клон; same — тот же репозиторий без правок, встанет ветка точки;
 *  dirty — в папке несохранённые правки (files), её файлы остаются; shared — в ней работают другие сессии (sessions), файлы остаются; other — другой репозиторий, отказ. */
export const RaiseCheck = z.object({ folder: z.enum(["nogit", "empty", "same", "dirty", "shared", "other"]), dir: z.string(), files: z.number(), branch: z.string().nullable(), sessions: z.array(z.string()) });
export const pointsRaise = request("points.raise", {
  owner: "host-points", target: "machine",
  tool: "Поднять сессию из архива на машине: sid — сессия архива, point — точка (по умолчанию последняя), name — имя новой сессии, cwd — папка; move — перенос (прежняя машина отпускает сессию), иначе копия; files: point — вернуть файлы папки к точке, keep — оставить как есть; dryRun — только проверить папку.",
  input: z.object({
    to: MachineAddr, sid: z.string(), point: z.string().optional(), name: z.string().optional(), cwd: z.string().optional(), move: z.boolean().optional(),
    files: z.enum(["keep", "point"]).optional(), dryRun: z.boolean().optional(), slot: z.string().optional(),
    /** последняя точка, которую видел человек: в архиве уже другая — отказ changed */
    expect: z.string().optional(),
  }),
  output: z.object({ callsign: Callsign.optional(), check: RaiseCheck.optional() }),
});

/* ===== Скрипты (host-shell) ===== */

/** Снимок запуска. state: killed — снят запросом или остановкой Host, timeout — вышел предел timeout, stopped — снят пределом жизни запуска.
 *  out — stdout и stderr вместе, по порядку; stdout и stderr — они же раздельно; files — файлы, которые скрипт положил в папку $SB_OUT. */
export const Run = z.object({
  run: z.string(), state: z.enum(["running", "done", "failed", "killed", "timeout", "stopped"]), code: z.number().optional(),
  out: z.string().optional(), stdout: z.string().optional(), stderr: z.string().optional(), started: z.number(), ended: z.number().optional(), ms: z.number().optional(),
  files: z.array(z.object({ name: z.string(), size: z.number(), base64: z.string().optional() })).optional(),
});
export const shellRun = request("shell.run", {
  owner: "host-shell", target: "machine",
  tool: "Выполнить скрипт на машине: script — текст, cwd — папка, stdin — ввод скрипта, timeout — предел работы в секундах, wait — ждать конца до стольких секунд (иначе вернётся номер запуска, запуск идёт в фоне). Файлы, которые скрипт положит в папку из переменной SB_OUT, вернутся в ответе.",
  input: z.object({
    to: MachineAddr, script: z.string(), cwd: z.string().optional(), wait: z.number().optional(), shell: z.enum(["bash", "powershell", "pwsh", "node"]).optional(),
    stdin: z.string().optional(), timeout: z.number().optional(),
  }),
  output: Run,
});
export const shellWait = request("shell.wait", {
  owner: "host-shell", target: "machine", tool: "Дождаться конца запуска скрипта.",
  input: z.object({ to: MachineAddr, run: z.string(), wait: z.number().optional() }), output: Run,
});
export const shellKill = request("shell.kill", {
  owner: "host-shell", target: "machine", tool: "Снять запуск скрипта.",
  input: z.object({ to: MachineAddr, run: z.string() }), output: Run,
});
export const shellInfo = request("shell.info", {
  owner: "host-shell", target: "machine", tool: "Что это за машина: ОС, оболочки, папка пользователя.",
  input: toMachine,
  output: z.object({ os: z.string(), shells: z.array(z.string()), home: z.string(), node: z.string().optional(), found: z.array(z.object({ shell: z.string(), path: z.string(), version: z.string().nullable() })).optional() }),
});

/* ===== Инциденты (host-incidents) ===== */

/** Вложение обращения: тот же вид, что вложение сообщения. */
export const IncidentFile = z.object({ name: z.string(), mime: z.string(), base64: z.string() });
export const Incident = z.object({
  id: z.string(), kind: z.string(), key: z.string(), text: z.string(), at: z.number(),
  callsign: Callsign.optional(), state: z.enum(["pending", "taken", "done"]),
  /** обращение ждёт: почему не доставлено */
  why: z.string().optional(),
  /** имена вложений */
  files: z.array(z.string()).optional(),
});
export type Incident = z.infer<typeof Incident>;
export const incidentList = request("incident.list", {
  owner: "host-incidents", target: "machine", tool: "Обращения служб компьютера и сессии, которые их разбирают; у недоставленного — причина.",
  input: toMachine, output: z.object({ incidents: z.array(Incident), port: z.number().optional() }),
});
/** Обращение от службы компьютера: открывает сессию по виду обращения или пишет в уже открытую. */
export const incidentRaise = request("incident.raise", {
  owner: "host-incidents", target: "machine",
  input: z.object({ to: MachineAddr, kind: z.string(), key: z.string(), text: z.string(), files: z.array(IncidentFile).optional() }), output: z.object({ id: z.string(), callsign: Callsign.optional() }),
});
/** Правило вида обращений — ключ incidents.kinds настроек флота: имя вида → где открыть сессию, с чем, что ей сказать и кого позвать. */
export const IncidentKind = z.object({
  cwd: z.string(), pieces: z.array(z.string()).optional(), slot: z.string().optional(), model: z.string().optional(), project: z.string().optional(),
  /** добавка к промпту сессии этого вида */
  prompt: z.string().optional(),
  /** кого позвать о новом обращении: ~почта */
  notify: z.array(z.string()).optional(),
  /** только эти машины; пусто — все */
  machines: z.array(z.string()).optional(),
});
export type IncidentKind = z.infer<typeof IncidentKind>;

/* ===== Машина (host-machine) ===== */

export const machineDirs = request("machine.dirs", {
  owner: "host-machine", target: "machine",
  input: z.object({ to: MachineAddr, path: z.string().optional() }),
  output: z.object({ path: z.string(), dirs: z.array(z.string()), recent: z.array(z.string()).optional(), git: z.boolean().optional() }),
});
/** Разговоры папки на диске машины: их можно продолжить новой сессией. live — сессия, которая ведёт разговор сейчас. */
export const machineConversations = request("machine.conversations", {
  owner: "host", target: "machine", tool: "Разговоры Claude в папке на диске машины: номер, первая реплика, когда шёл последний раз.",
  input: z.object({ to: MachineAddr, cwd: z.string() }),
  output: z.object({ conversations: z.array(z.object({ id: z.string(), title: z.string(), at: z.number(), size: z.number(), live: z.string().optional() })) }),
});
export const JournalLine = z.object({ t: z.number(), part: z.string(), level: z.enum(["info", "warn", "error"]), msg: z.string() }).loose();
export const machineJournal = request("machine.journal", {
  owner: "host-machine", target: "machine", tool: "Журнал машины: строки Host, Keeper и держателей. part — чей, before — время, до которого читать.",
  input: z.object({
    to: MachineAddr, part: z.string().optional(), level: z.enum(["info", "warn", "error"]).optional(), before: z.number().optional(), limit: z.number().optional(),
    /** только строки этого сквозного номера запроса; имя trace занято конвертом */ of: z.string().optional(),
    /** только строки этой сессии */ session: Callsign.optional(),
    /** не раньше этого времени, мс */ since: z.number().optional(),
    /** вид строки: stop — остановки и сбои, refuse — отказы запросам, note — остальное */ kind: z.enum(["stop", "refuse", "note"]).optional(),
  }),
  output: z.object({ lines: z.array(JournalLine), more: z.boolean() }),
});

/** Числа Host за минуту: сессии по состояниям, очередь ввода, время ответа провайдера (до первых заголовков), сбои и возобновления процессов. */
export const HostMetrics = z.object({
  at: z.number(),
  build: z.number().optional(),
  /** сколько сессий в каждом состоянии */
  sessions: z.record(z.string(), z.number()),
  /** сообщений, ждущих во вводе всех сессий */
  queue: z.number(),
  provider: z.object({ n: z.number(), p50: z.number(), p95: z.number(), failed: z.number(), retries: z.number() }),
  /** процесс claude вышел сам; из них возобновлено */
  crashes: z.number(),
  resumes: z.number(),
});
export type HostMetrics = z.infer<typeof HostMetrics>;
export const machineMetrics = request("machine.metrics", {
  owner: "host-machine", target: "machine", tool: "Числа Host машины за последнюю минуту: сессии по состояниям, очередь ввода, время ответа провайдера, сбои процессов.",
  input: toMachine, output: HostMetrics,
});

/* ===== Keeper ===== */

export const keeperState = request("keeper.state", {
  owner: "keeper", target: "keeper", tool: "Состояние Keeper машины: какая сборка Host стоит, работает ли он.",
  input: z.object({ to: KeeperAddr }),
  output: z.object({ build: z.number(), host: z.object({ build: z.number(), state: z.enum(["running", "stopped", "failed", "updating"]), why: z.string().optional(), since: z.number().optional(), pid: z.number().optional() }), os: z.string(),
    /** сборка последнего исполненного плана и pid самого Keeper */
    plan: z.number().optional(), pid: z.number().optional() }),
});

/** Перезапустить Host той же сборки: остановить и запустить; упавший — поднять. Сессии живут в держателях. Только владелец машины или админ. */
export const hostRestart = request("host.restart", {
  owner: "keeper", target: "keeper", ownerOnly: true, tool: "Перезапустить Host машины: to — keeper вида .keeper@laptop. Сессии не останавливаются.",
  input: z.object({ to: KeeperAddr }), output: Done,
});

/** «Спроси план»: служба выпусков → Keeper, без данных. */
export const planChanged = frame("plan.changed", { owner: "builds", payload: z.object({}) });
/** «Изменилось»: настройки флота или ключи — Host перечитывает названное. */
export const changed = frame("changed", { owner: "prefs", payload: z.object({ what: z.string() }) });
