// Мок флота: провод договора в памяти страницы. Живой: занятые сессии пишут события, ответ на вопрос меняет состояние, записи видны сразу.
import {
  type Account, type ArchPoint, type ArchSession, type Ask, type DeviceRow, type Frame, type Incident, type KeyRow, type LedgerEvent, type Link, type MachineRow,
  type ObsRow, type PassRow, type PersonRow, type Piece, type Project, type Reply, type SessionRow, type Span, type Transport, fail, machineOf, newId, ok, Refusal,
} from "@sb/protocol";
import { done, type Ev, liveSteps, peer, reply, researchTurn, say, shortTurn, siteTurn, text, uid } from "./convo.ts";

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const ME = "~yuri@example.com", ANYA = "~anya@example.com", OLEG = "~oleg@example.com";
const MY_ADDR = "pult" + ME;

type Live = { steps: Array<() => Ev[]>; then?: () => void };

export type MockOptions = { now?: () => number; live?: boolean; latency?: number };

export function createMock(o: MockOptions = {}) {
  const now = o.now ?? (() => Date.now());
  const T = now();
  const latency = o.latency ?? 90;
  let rev = 1;

  /* ===== Люди, проекты, машины ===== */
  const people: PersonRow[] = [
    { person: ME, name: "Юра", admin: true, projects: ["site", "infra", "research"], at: T - 40 * DAY },
    { person: ANYA, name: "Аня", admin: false, projects: ["site"], at: T - 21 * DAY },
    { person: OLEG, name: "Олег", admin: false, projects: ["infra"], at: T - 9 * DAY },
  ];
  const projects: Project[] = [
    { id: "site", name: "Сайт", members: [ME, ANYA] },
    { id: "infra", name: "Инфра", members: [ME, OLEG] },
    { id: "research", name: "Исследования", members: [ME] },
  ];
  const machines: Record<string, MachineRow> = {
    laptop: { name: "laptop", owner: ME, online: true, since: T - 5 * HOUR, build: 412, sdk: "0.3.321", os: "Windows 11", keeper: true },
    server: { name: "server", owner: ME, online: true, since: T - 6 * DAY, build: 412, sdk: "0.3.321", os: "Ubuntu 24.04", keeper: true },
    "anya-pc": { name: "anya-pc", owner: ANYA, online: true, since: T - 2 * HOUR, build: 411, sdk: "0.3.321", os: "Windows 11", keeper: true },
    base2: { name: "base2", owner: ME, online: false, since: T - 3 * HOUR, build: 410, sdk: "0.3.311", os: "Ubuntu 22.04", keeper: false },
  };

  /* ===== Сессии ===== */
  const M = "claude-fable-5-2";
  const ask = (a: Omit<Ask, "id" | "at">, minAgo: number): Ask => ({ id: uid("q"), at: T - minAgo * MIN, ...a });
  const row = (callsign: string, state: SessionRow["state"], project: string | undefined, r: Partial<SessionRow> & { cwd?: string; model?: string; pieces?: string[]; mode?: SessionRow["spec"]["mode"] } = {}): SessionRow => {
    const { cwd, model, pieces, mode, ...rest } = r;
    const name = callsign.slice(0, callsign.indexOf("@"));
    return {
      callsign, state, by: ME, since: T - 8 * HOUR, last: T - 30 * MIN,
      spec: { name, cwd: cwd ?? `~/projects/${name}`, model: model ?? M, effort: "high", mode: mode ?? "all", account: "auto", pieces: pieces ?? ["base"], backup: true, ...(project ? { project } : {}) },
      account: "yuri@example.com", context: 0.31, ...rest,
    };
  };
  const sessions: Record<string, SessionRow> = {};
  const add = (r: SessionRow) => (sessions[r.callsign] = r);

  add(row("site@laptop", "busy", "site", { title: "Шапка сайта на узких экранах", doing: "Правит src/components/Header.tsx", pieces: ["base", "web"], last: T - 1 * MIN, context: 0.42 }));
  add(row("site-tests@laptop", "waiting", "site", { title: "Выкладка тестового стенда", pieces: ["base", "web"], last: T - 6 * MIN,
    ask: ask({ kind: "question", title: "Ветка для выкладки", text: "Какую ветку выкладывать на тестовый стенд?", options: [{ label: "main", about: "последний зелёный коммит" }, { label: "release/2.4", about: "ветка выпуска" }, { label: "Обе по очереди" }] }, 6) }));
  add(row("docs@laptop", "idle", "site", { title: "Раздел про выкладку в документации", unread: [ME], last: T - 14 * MIN, context: 0.18, result: "Дописал раздел «Выкладка»: три шага, откат и пример. Проверил ссылки в разделе — 14 из 14 открываются." }));
  add(row("lead@laptop", "busy", "research", { title: "Замена клиента оплаты", doing: "Ждёт итог от wing@laptop", last: T - 2 * MIN, spec: { name: "lead", cwd: "~/projects/billing", model: M, effort: "xhigh", mode: "all", account: "auto", pieces: ["base", "research"], wing: "wing@laptop", project: "research", backup: true } }));
  add(row("wing@laptop", "busy", "research", { title: "Поиск вызовов старого клиента", doing: "Читает src/jobs/renew.ts", by: "lead@laptop", last: T - 1 * MIN, model: "claude-sonnet-5-5", spec: { name: "wing", cwd: "~/projects/billing", model: "claude-sonnet-5-5", effort: "medium", mode: "all", account: "auto", pieces: ["base"], parent: "lead@laptop", project: "research", backup: true } }));
  add(row("hotfix@laptop", "failed", "site", { title: "Срочная правка формы входа", error: "процесс claude дважды вышел до готовности: код 1, «Invalid API key»", last: T - 50 * MIN, account: "work@example.com" }));
  add(row("deploy@server", "waiting", "infra", { title: "Пересборка и выкладка статики", mode: "ask", last: T - 3 * MIN, pieces: ["base", "ops"],
    ask: ask({ kind: "permission", title: "Команда", text: "rm -rf dist && npm run build", tool: "Bash", input: { command: "rm -rf dist && npm run build", description: "Чистая пересборка" }, options: [{ label: "Разрешить" }, { label: "Разрешать всегда" }, { label: "Отклонить" }] }, 3) }));
  add(row("api@server", "waiting", "infra", { title: "Предел запросов на входе", mode: "plan", last: T - 22 * MIN, pieces: ["base", "ops"],
    ask: ask({ kind: "plan", title: "План", text: "## Предел запросов на входе\n\n1. Счётчик на адрес в памяти процесса, окно 10 секунд.\n2. Отказ `429` со словом `too_many` и временем сброса.\n3. Тесты: 3 сценария — ровно на пределе, сверх предела, после сброса.\n\nФайлы: `src/entrance.ts`, `src/limit.ts`, `test/limit.test.ts`.", options: [{ label: "Делай" }, { label: "Делай, правки без вопросов" }, { label: "Доработать" }] }, 22) }));
  add(row("ingest@server", "busy", "infra", { title: "Разбор ночной выгрузки", doing: "Выполняет node scripts/ingest.mjs", last: T - 1 * MIN, context: 0.67, pieces: ["base", "ops"] }));
  add(row("nightcheck@server", "idle", "infra", { title: "Ночная проверка флота", last: T - 7 * HOUR, by: "~yuri@example.com", pieces: ["base", "ops"] }));
  add(row("migrate@server", "stopped", "infra", { title: "Перенос журналов в архив", last: T - 2 * DAY, pieces: ["base"] }));
  add(row("landing@anya-pc", "busy", "site", { title: "Новый первый экран", doing: "Собирает снимки на 390 и 1440", by: ANYA, last: T - 2 * MIN, account: "anya@example.com", pieces: ["base", "web"] }));
  add(row("design@anya-pc", "idle", "site", { title: "Палитра и сетка", by: ANYA, unread: [ME, ANYA], result: "Тёмный вариант готов: фон #0F1413, контраст 11,4 : 1. Оба варианта лежат рядом, выберите один.", last: T - 41 * MIN, account: "anya@example.com", pieces: ["base", "web"] }));
  add(row("forms@anya-pc", "waiting", "site", { title: "Форма заявки", by: ANYA, last: T - 9 * MIN, account: "anya@example.com", pieces: ["base", "web"],
    ask: ask({ kind: "form", title: "Доступ к почтовому серверу", text: "Нужны данные почтового сервера для отправки заявок.", schema: { type: "object", required: ["host", "user"], properties: { host: { type: "string", title: "Сервер" }, port: { type: "number", title: "Порт", default: 587 }, user: { type: "string", title: "Пользователь" } } } }, 9) }));
  add(row("crawler@base2", "busy", "research", { title: "Сбор цен конкурентов", doing: "Последнее известное: шёл обход каталога", last: T - 3 * HOUR, pieces: ["base", "research"] }));
  add(row("backup@base2", "idle", "infra", { title: "Проверка резервных копий", last: T - 9 * HOUR, pieces: ["base", "ops"] }));

  /* ===== Разговоры ===== */
  const talks = new Map<string, Ev[]>();
  const talk = (c: string) => talks.get(c) ?? (talks.set(c, []), talks.get(c)!);
  talk("site@laptop").push(...siteTurn(T - 3 * HOUR, "Шапка ломается на телефоне: меню вылезает за край. Почини и приложи снимки."), say("Теперь то же для подвала: ссылки должны складываться в столбик.", T - 2 * MIN));
  talk("site-tests@laptop").push(...shortTurn(T - 40 * MIN, "Подними тестовый стенд из свежей сборки.", "Стенд поднят на сборке 412. Адрес — `https://stand.example.com`."), say("Выложи на него сайт.", T - 7 * MIN), reply([text("Перед выкладкой уточню ветку.")], T - 6 * MIN));
  talk("docs@laptop").push(...shortTurn(T - 2 * HOUR, "Что у нас написано про откат сборки?", "В разделе «Выпуски» одна строка: откат делается той же командой с прежним номером. Примера нет."), ...siteTurn(T - 50 * MIN, "Допиши раздел про выкладку: шаги, откат, пример команды.").slice(0, 1),
    reply([text("Дописал раздел «Выкладка»: три шага, откат и пример.\n\n```bash\nnpm run deploy -- prod 412   # выложить\nnpm run deploy -- prod 411   # откатить\n```\n\nПроверил ссылки в разделе — 14 из 14 открываются.")], T - 15 * MIN), done(T - 14 * MIN, 96_000, 0.31, 5, 36_000));
  talk("lead@laptop").push(...researchTurn(T - 30 * MIN, "Надо уйти со старого клиента оплаты. Разберись, где он используется, и предложи замену."), say("Делай обёртку. Поиск оставшихся вызовов отдай ведомому.", T - 4 * MIN), reply([text("Отдал поиск ведомому `wing@laptop`, сам пишу обёртку.")], T - 3 * MIN));
  talk("wing@laptop").push(peer("lead@laptop", "Найди все оставшиеся вызовы payments/legacy после правки обёртки и пришли список файлов.", T - 3 * MIN));
  talk("hotfix@laptop").push(say("Форма входа падает при пустом пароле. Почини срочно.", T - 55 * MIN));
  talk("deploy@server").push(...shortTurn(T - 25 * MIN, "Какая сборка статики сейчас на сервере?", "На сервере сборка от вчера, 18:40, коммит `a41f9c2`."), say("Пересобери с нуля и выложи.", T - 4 * MIN), reply([text("Начну с чистой пересборки.")], T - 3 * MIN));
  talk("api@server").push(say("Добавь предел запросов на входе. Сначала план.", T - 26 * MIN), reply([text("Составил план, жду решения.")], T - 22 * MIN));
  talk("ingest@server").push(say("Разбери ночную выгрузку и скажи, сколько строк не прошло проверку.", T - 12 * MIN));
  talk("nightcheck@server").push(...shortTurn(T - 7 * HOUR, "Проверь флот: все ли машины на последней сборке.", "Три машины из четырёх на сборке 412. `base2` — на 410 и без связи с 02:10."));
  talk("migrate@server").push(...shortTurn(T - 2 * DAY, "Перенеси журналы старше 30 дней в архив.", "Перенесено 1 284 файла, 3,1 ГБ. Сессию можно останавливать."));
  talk("landing@anya-pc").push(say("Собери первый экран по макету из design@anya-pc.", T - 20 * MIN));
  talk("design@anya-pc").push(...shortTurn(T - 90 * MIN, "Предложи палитру и сетку для сайта.", "Палитра из пяти цветов и сетка на 12 колонок — в `design/tokens.json`. Контраст текста 7,2 : 1."), ...shortTurn(T - 42 * MIN, "Сделай вариант темнее.", "Тёмный вариант готов: фон `#0F1413`, контраст 11,4 : 1. Оба варианта лежат рядом, выберите один."));
  talk("forms@anya-pc").push(say("Форма заявки должна слать письмо менеджеру.", T - 10 * MIN), reply([text("Для отправки нужны данные почтового сервера.")], T - 9 * MIN));
  talk("crawler@base2").push(say("Собери цены конкурентов по списку из prices/sources.txt.", T - 5 * HOUR));
  talk("backup@base2").push(...shortTurn(T - 9 * HOUR, "Проверь, что ночные копии читаются.", "Копии за 7 ночей читаются, размеры от 1,9 до 2,2 ГБ."));

  const live = new Map<string, Live>();
  const startLive = (c: string, about: string, then?: () => void) => live.set(c, { steps: liveSteps(now, about), then });
  startLive("site@laptop", "подвал сайта");
  startLive("ingest@server", "ночная выгрузка");
  startLive("landing@anya-pc", "первый экран");
  startLive("wing@laptop", "поиск вызовов");

  /* ===== Остальные записи ===== */
  const lim = (five: number, week: number) => [{ name: "five_hour", used: five, resets: T + 2 * HOUR }, { name: "seven_day", used: week, resets: T + 3 * DAY }];
  const accounts: Record<string, Account[]> = {
    laptop: [
      { id: "yuri@example.com", kind: "claude", email: "yuri@example.com", plan: "Max 20x", limits: lim(0.46, 0.38), slot: 1, ok: true, sessions: 4 },
      { id: "work@example.com", kind: "claude", email: "work@example.com", plan: "Max 5x", limits: lim(0.93, 0.71), slot: 2, ok: false, why: "вход устарел: войдите заново", sessions: 1 },
      { id: "orca-glm", kind: "key", ok: true, sessions: 0 },
    ],
    server: [
      { id: "yuri@example.com", kind: "claude", email: "yuri@example.com", plan: "Max 20x", limits: lim(0.46, 0.38), slot: 1, ok: true, sessions: 3 },
      { id: "ops@example.com", kind: "claude", email: "ops@example.com", plan: "Max 5x", limits: lim(0.12, 0.2), slot: 2, ok: true, sessions: 2 },
    ],
    "anya-pc": [{ id: "anya@example.com", kind: "claude", email: "anya@example.com", plan: "Max 5x", limits: lim(0.64, 0.52), slot: 1, ok: true, sessions: 3 }],
    base2: [],
  };
  const pieces: Piece[] = [
    { id: "base", repo: "github.com/example/sb-base", title: "Основа", about: "Правила работы, общие скилы и хуки", has: { скилы: 6, хуки: 3, настройки: 1 }, rev: "a41f9c2", ok: true },
    { id: "web", repo: "github.com/example/sb-web", title: "Веб", about: "Снимки экранов, проверка доступности, дизайн", has: { скилы: 4, агенты: 2, "серверы MCP": 1 }, rev: "7be2d10", ok: true },
    { id: "ops", repo: "github.com/example/sb-ops", title: "Эксплуатация", about: "Выкладка, журналы, тревоги", has: { скилы: 5, команды: 3 }, rev: "19c0e77", ok: true },
    { id: "research", repo: "github.com/example/sb-research", title: "Исследования", about: "Поиск, сводки источников", has: { скилы: 3, агенты: 1 }, rev: "e3f8a01", ok: false, why: "репозиторий не клонируется: нет доступа у приложения GitHub" },
  ];
  const archive: ArchSession[] = [
    ["site", "laptop", "Шапка сайта на узких экранах", 6, 1], ["docs", "laptop", "Раздел про выкладку в документации", 4, 14], ["billing", "laptop", "Замена клиента оплаты", 9, 3 * 60],
    ["deploy", "server", "Пересборка и выкладка статики", 12, 25], ["nightcheck", "server", "Ночная проверка флота", 31, 7 * 60], ["migrate", "server", "Перенос журналов в архив", 3, 2 * 24 * 60],
    ["landing", "anya-pc", "Новый первый экран", 5, 20], ["design", "anya-pc", "Палитра и сетка", 7, 42], ["crawler", "base2", "Сбор цен конкурентов", 14, 3 * 60],
    ["auth", "laptop", "Вход по ссылке вместо пароля", 8, 5 * 24 * 60], ["search", "server", "Поиск по каталогу: индекс и выдача", 11, 6 * 24 * 60], ["invoices", "server", "Счета: выгрузка в PDF", 5, 9 * 24 * 60],
  ].map(([name, machine, title, points, minAgo], i) => ({
    sid: `s${(1000 + i * 37).toString(16)}`, machine: machine as string, callsign: `${name}@${machine}`, title: title as string, model: i % 4 === 3 ? "claude-sonnet-5-5" : M,
    cwd: `~/projects/${name}`, project: ["site", "site", "research", "infra", "infra", "infra", "site", "site", "research", "site", "infra", "infra"][i], points: points as number,
    last: T - (minAgo as number) * MIN, bytes: 400_000 + i * 173_000, tokens: 180_000 + i * 61_000,
  }));
  const archPoints = (s: ArchSession): ArchPoint[] => Array.from({ length: s.points }, (_, i) => ({ point: `p${i + 1}`, at: s.last - (s.points - 1 - i) * 47 * MIN, turns: 2 + i * 3, bytes: 60_000 + i * 41_000, ...(i === s.points - 1 ? { label: "последняя" } : i === 0 ? { label: "начало" } : {}), git: (0xa41f9c2 + i * 7919).toString(16).slice(0, 7) }));
  const builds = { stable: 412 as number | null, pins: { base2: 410 } as Record<string, number>, builds: [412, 411, 410, 409].map((b, i) => ({ build: b, at: T - (i * 26 + 3) * HOUR, commit: ["9d5fdbb", "fe5e628", "19ac492", "2fb7d26"][i], note: ["Вопрос в строке сессии; правка ленты", "Архив: поиск по словам", "Права по проектам", "Один сервер MCP"][i], files: ["host.tgz", "keeper-windows.exe", "keeper-linux"] })) };
  const passes: PassRow[] = [
    { kid: "k1a2b3", addr: "pult" + ME, person: ME, wait: false, at: T - 40 * DAY, seen: T - MIN },
    { kid: "k4c5d6", addr: "phone" + ME, person: ME, wait: false, at: T - 38 * DAY, seen: T - 3 * HOUR },
    { kid: "k7e8f9", addr: "cli" + ME, person: ME, wait: false, at: T - 12 * DAY, seen: T - 2 * DAY },
    { kid: "kaa11b", addr: "pult" + ANYA, person: ANYA, wait: false, at: T - 21 * DAY, seen: T - 20 * MIN },
    { kid: "kbb22c", addr: "phone" + OLEG, person: OLEG, wait: false, at: T - 9 * DAY, seen: T - 4 * DAY },
    { kid: "kcc33d", addr: "pult" + OLEG, person: OLEG, wait: true, at: T - 2 * HOUR },
    { kid: "km1lap", addr: "@laptop", person: ME, wait: false, at: T - 40 * DAY, seen: T - MIN },
    { kid: "km2srv", addr: "@server", person: ME, wait: false, at: T - 39 * DAY, seen: T - MIN },
    { kid: "km3any", addr: "@anya-pc", person: ANYA, wait: false, at: T - 21 * DAY, seen: T - MIN },
    { kid: "km4bs2", addr: "@base2", person: ME, wait: false, at: T - 30 * DAY, seen: T - 3 * HOUR },
  ];
  const devices: DeviceRow[] = [
    { id: "d1", kind: "webpush", person: ME, label: "Телефон, Chrome", at: T - 38 * DAY, kid: "k4c5d6" },
    { id: "d2", kind: "telegram", person: ME, label: "Telegram: Switchboard", at: T - 20 * DAY },
  ];
  const keys: KeyRow[] = [
    { name: "orca-glm", provider: "openai-compatible", base: "https://api.orca.example/v1", model: "glm-abliterated", at: T - 6 * DAY, tail: "…9f3c" },
    { name: "meta-muse", provider: "meta", model: "muse-spark", at: T - 2 * DAY, tail: "…a07d" },
  ];
  const incidents: Record<string, Incident[]> = {
    server: [
      { id: "i1", kind: "disk", key: "/var", text: "Диск /var занят на 91%", at: T - 35 * MIN, callsign: "nightcheck@server", state: "taken" },
      { id: "i2", kind: "cert", key: "stand.example.com", text: "Сертификат stand.example.com истекает через 6 дней", at: T - 4 * HOUR, state: "pending" },
    ],
    laptop: [{ id: "i3", kind: "watchdog", key: "host", text: "Host перезапущен Keeper после падения", at: T - 5 * HOUR, state: "done" }],
  };
  const prefs: Record<"me" | "fleet", Record<string, unknown>> = {
    me: { pins: ["site@laptop"], view: { work: "list" } },
    fleet: {
      "labels": { "site@laptop": "Сайт: шапка и подвал" },
      "proxy.rules": [
        { name: "Внутренние адреса", match: "internal\\.example\\.com", replace: "example.com", on: true },
        { name: "Имена клиентов", match: "ООО «[^»]+»", replace: "ООО «Клиент»", on: true },
        { name: "Номера карт", match: "\\b\\d{4} \\d{4} \\d{4} \\d{4}\\b", replace: "**** **** **** ****", on: false },
      ],
    },
  };
  const ledger: LedgerEvent[] = [
    ["builds.deployed", "pult" + ME, undefined, "Сборка 412 назначена флоту", 3 * HOUR], ["host.updated", "@laptop", "laptop", "Host 411 → 412", 3 * HOUR - 2 * MIN], ["host.updated", "@server", "server", "Host 411 → 412", 3 * HOUR - 3 * MIN],
    ["machine.left", "@base2", "base2", "Машина ушла со связи", 3 * HOUR], ["session.failed", "@laptop", "laptop", "hotfix@laptop: процесс claude дважды вышел до готовности", 50 * MIN],
    ["account.expired", "@laptop", "laptop", "work@example.com: вход устарел", 52 * MIN], ["pass.invited", "pult" + ME, undefined, "Приглашение для pult~oleg@example.com", 2 * HOUR],
    ["host.restarted", ".keeper@laptop", "laptop", "Host перезапущен после падения", 5 * HOUR], ["analytics.failed", ".analytics", undefined, "ClickHouse не ответил за 10 с; точка s3e8/p9 ждёт долива", 6 * HOUR],
    ["people.set", "pult" + ME, undefined, "Олег добавлен в проект «Инфра»", 9 * DAY], ["builds.deployed", "pult" + ME, undefined, "Сборка 411 назначена флоту", 29 * HOUR], ["pass.revoked", "pult" + ME, undefined, "Отозван пропуск tablet~yuri@example.com", 6 * DAY],
  ].map(([what, who, machine, textOf, agoMs], i) => ({ id: "e" + i, at: T - (agoMs as number), what: what as string, who: who as string, ...(machine ? { machine: machine as string } : {}), text: textOf as string, trace: "t" + (0x51a7 + i * 733).toString(36) }));

  const obs: ObsRow[] = [];
  const TYPES: Array<[string, string, Span[]]> = [
    ["message", "site@laptop", [{ part: "services", ms: 4 }, { part: "platform", ms: 3 }, { part: "host", ms: 21 }]],
    ["session.history", "docs@laptop", [{ part: "services", ms: 3 }, { part: "platform", ms: 2 }, { part: "host", ms: 64 }]],
    ["points.list", "", [{ part: "services", ms: 6 }, { part: "archive", ms: 38 }]],
    ["prefs.get", "", [{ part: "services", ms: 2 }, { part: "prefs", ms: 5 }]],
    ["account.list", "@server", [{ part: "services", ms: 3 }, { part: "platform", ms: 2 }, { part: "host", ms: 180 }]],
    ["session.update", "ingest@server", [{ part: "services", ms: 3 }, { part: "platform", ms: 3 }, { part: "host", ms: 44 }]],
    ["analytics.query", "", [{ part: "services", ms: 4 }, { part: "analytics", ms: 420 }]],
    ["ledger.read", "", [{ part: "services", ms: 2 }, { part: "ledger", ms: 9 }]],
  ];
  const FAILS: Array<[string, string, string, string, Span[]]> = [
    ["message", "crawler@base2", "offline", "машина base2 не на связи", [{ part: "services", ms: 3 }, { part: "platform", ms: 2 }]],
    ["builds.deploy", "", "forbidden", "нужен админ флота", [{ part: "services", ms: 2 }]],
    ["session.open", "@laptop", "bad_input", "spec.cwd: папка не найдена — ~/projects/nope", [{ part: "services", ms: 3 }, { part: "platform", ms: 2 }, { part: "host", ms: 12 }]],
    ["analytics.query", "", "analytics_unavailable", "ClickHouse не ответил за 10 с", [{ part: "services", ms: 4 }, { part: "analytics", ms: 10_004 }]],
    ["shell.run", "@server", "timeout", "Host не ответил за 120 с", [{ part: "services", ms: 3 }, { part: "platform", ms: 120_000 }]],
  ];
  const FROM = ["pult" + ME, "pult" + ME, "phone" + ME, "pult" + ANYA, "site@laptop", "lead@laptop", "@server"];
  for (let i = 0; i < 90; i++) {
    const failed = i % 11 === 4;
    if (failed) {
      const [type, to, word, why, spans] = FAILS[(i / 11) % FAILS.length | 0];
      obs.push({ trace: "t" + (0x9c41 + i * 977).toString(36), at: T - i * 97_000, type, from: FROM[i % FROM.length], ...(to ? { to } : {}), ok: false, word, why, ms: spans.reduce((a, s) => a + s.ms, 0), spans });
    } else {
      const [type, to, base] = TYPES[i % TYPES.length];
      const spans = base.map((s, j) => ({ part: s.part, ms: Math.max(1, Math.round(s.ms * (0.6 + ((i * 7 + j * 3) % 10) / 8))) }));
      obs.push({ trace: "t" + (0x9c41 + i * 977).toString(36), at: T - i * 97_000, type, from: FROM[i % FROM.length], ...(to ? { to } : {}), ok: true, ms: spans.reduce((a, s) => a + s.ms, 0), spans });
    }
  }
  const journal = (machine: string) => {
    const parts = ["host", "host", "keeper", "holder", "host"];
    const msgs: Array<[string, "info" | "warn" | "error"]> = [
      ["запрос message принят", "info"], ["сессия site: ход начат", "info"], ["план получен: сборка 412", "info"], ["процесс claude запущен, pid 18420", "info"], ["сессия site: ход окончен за 53 с", "info"],
      ["аккаунт work@example.com: вход устарел", "warn"], ["сессия hotfix: процесс вышел с кодом 1", "error"], ["сессия hotfix: второй сбой до готовности — failed", "error"], ["точка p6 сохранена: 4 блока, 212 КБ", "info"], ["правила прокси перечитаны: 3", "info"],
    ];
    return Array.from({ length: 40 }, (_, i) => ({ t: T - i * 83_000, part: parts[i % parts.length], level: msgs[i % msgs.length][1], msg: msgs[i % msgs.length][0], machine, trace: "t" + (0x9c41 + i * 977).toString(36) }));
  };
  let analyticsDown = false;

  /* ===== Соединения ===== */
  const pages = new Set<(f: Frame) => void>();
  const watchers = new Set<{ machine: string; on: (f: Frame) => void }>();
  const watched = new Set<string>();
  const seqs = new Map<string, number>();
  const snapshot = (): Frame => ({ type: "roster", rev, you: { addr: MY_ADDR, person: ME, admin: true }, machines: Object.values(machines), sessions: Object.values(sessions) });
  const delta = (d: object) => {
    rev++;
    for (const p of pages) p({ type: "roster.delta", rev, ...d });
  };
  const setRow = (c: string, patch: Partial<SessionRow> | null) => {
    if (patch === null) delete sessions[c];
    else sessions[c] = { ...sessions[c], ...patch };
    delta({ sessions: [{ callsign: c, row: patch === null ? null : sessions[c] }] });
  };
  const emit = (c: string, events: Ev[]) => {
    talk(c).push(...events);
    const seq = (seqs.get(c) ?? talk(c).length - events.length) + events.length;
    seqs.set(c, seq);
    if (!watched.has(c)) return;
    for (const w of watchers) if (w.machine === machineOf(c)) w.on({ type: "session.events", callsign: c, seq, events });
  };
  const DOING: Record<string, (i: any) => string> = { Read: (i) => `Читает ${i.file_path}`, Edit: (i) => `Правит ${i.file_path}`, Bash: (i) => `Выполняет ${String(i.command).slice(0, 60)}`, Glob: () => "Ищет файлы", Grep: (i) => `Ищет «${i.pattern}»`, Task: (i) => `Субагент: ${i.description}` };
  const tick = () => {
    for (const [c, l] of [...live]) {
      const s = sessions[c];
      if (!s || s.state !== "busy" || !machines[machineOf(c)!]?.online) continue;
      const step = l.steps.shift();
      if (!step) {
        live.delete(c);
        continue;
      }
      const events = step();
      emit(c, events);
      const tool = events.flatMap((e) => (e.type === "assistant" ? (e.message.content as any[]) : [])).findLast((b) => b.type === "tool_use");
      if (events.some((e) => e.type === "result")) {
        live.delete(c);
        const said = events.flatMap((e) => (e.type === "assistant" ? (e.message.content as any[]) : [])).findLast((b) => b.type === "text")?.text as string | undefined;
        setRow(c, { state: "idle", doing: undefined, last: now(), unread: watched.has(c) ? [] : [ME], ...(said ? { result: said.replace(/[`*#|]/g, "").slice(0, 200) } : {}) });
        l.then?.();
      } else if (tool) setRow(c, { doing: DOING[tool.name]?.(tool.input) ?? tool.name });
    }
  };
  const timer = o.live === false ? null : setInterval(tick, 1600);

  /* ===== Запросы ===== */
  const need = <T>(v: T | undefined, why: string): T => {
    if (v === undefined) throw new Refusal("not_found", why);
    return v;
  };
  const sess = (f: Frame) => {
    const c = String(f.to);
    const s = need(sessions[c], `сессии ${c} нет`);
    if (!machines[machineOf(c)!]?.online) throw new Refusal("offline", `машина ${machineOf(c)} не на связи`);
    return { c, s };
  };
  const mach = (f: Frame) => {
    const m = String(f.to).replace(/^(\.keeper)?@/, "");
    const row = need(machines[m], `машины ${m} нет`);
    if (!row.online) throw new Refusal("offline", `машина ${m} не на связи`);
    return m;
  };
  const page = <T>(list: T[], before: number | undefined, limit: number, at: (x: T) => number) => {
    const rest = before ? list.filter((x) => at(x) < before) : list;
    return { items: rest.slice(0, limit), more: rest.length > limit };
  };
  const logins = new Map<string, string>();

  const H: Record<string, (f: any) => unknown> = {
    whoami: () => ({ addr: MY_ADDR, person: ME, admin: true, machines: Object.keys(machines), fleet: "home" }),
    redeem: () => ({ key: "home:k1a2b3:mockmockmockmockmock", addr: MY_ADDR }),
    invite: (f) => {
      const kid = "k" + newId().slice(0, 6);
      passes.unshift({ kid, addr: f.addr, person: f.owner ?? (String(f.addr).includes("~") ? "~" + String(f.addr).split("~")[1] : ME), wait: true, at: now() });
      return { kid, invite: `home:${kid}:${newId()}${newId()}` };
    },
    passes: () => ({ passes }),
    revoke: (f) => {
      const i = passes.findIndex((p) => p.kid === f.kid);
      if (i < 0) throw new Refusal("not_found", "такого пропуска нет");
      passes.splice(i, 1);
      return {};
    },
    "people.list": () => ({ people, projects }),
    "people.set": (f) => {
      let p = people.find((x) => x.person === f.person);
      if (!p) people.push((p = { person: f.person, admin: false, projects: [], at: now() }));
      if (f.name !== undefined) p.name = f.name;
      if (f.admin !== undefined) p.admin = f.admin;
      if (f.projects) {
        p.projects = f.projects;
        for (const pr of projects) pr.members = people.filter((x) => x.projects.includes(pr.id)).map((x) => x.person);
      }
      return {};
    },
    "people.remove": (f) => (people.splice(people.findIndex((p) => p.person === f.person), 1), {}),
    "project.set": (f) => {
      const p = projects.find((x) => x.id === f.project);
      if (p) Object.assign(p, { name: f.name, ...(f.members ? { members: f.members } : {}) });
      else projects.push({ id: f.project, name: f.name, members: f.members ?? [ME] });
      return {};
    },
    "project.remove": (f) => (projects.splice(projects.findIndex((p) => p.id === f.project), 1), {}),

    "session.open": (f) => {
      const m = mach(f);
      const c = `${f.spec.name}@${m}`;
      if (sessions[c]) throw new Refusal("name_taken", `сессия ${c} уже есть`);
      sessions[c] = { callsign: c, state: "starting", spec: { mode: "all", account: "auto", effort: "high", model: M, pieces: ["base"], backup: true, ...f.spec }, by: MY_ADDR, since: now(), last: now(), account: accounts[m]?.[0]?.id, context: 0.02, ...(f.prompt ? { title: String(f.prompt).slice(0, 60) } : {}) };
      delta({ sessions: [{ callsign: c, row: sessions[c] }] });
      setTimeout(() => {
        if (!sessions[c]) return;
        if (f.prompt) {
          emit(c, [say(f.prompt, now())]);
          startLive(c, String(f.prompt).slice(0, 40));
          setRow(c, { state: "busy", doing: "Читает задачу" });
        } else setRow(c, { state: "idle" });
      }, 1200);
      return { callsign: c };
    },
    "session.update": (f) => {
      const { c, s } = sess(f);
      setRow(c, { spec: { ...s.spec, ...f.patch } });
      return {};
    },
    "session.stop": (f) => (setRow(sess(f).c, { state: "stopped", doing: undefined, ask: null }), {}),
    "session.start": (f) => (setRow(String(f.to), { state: "idle", error: undefined }), {}),
    "session.remove": (f) => (setRow(String(f.to), null), {}),
    "session.call": (f) => {
      const { c } = sess(f);
      if (f.method === "interrupt") {
        live.delete(c);
        emit(c, [say("[Request interrupted by user]", now())]);
        setRow(c, { state: "idle", doing: undefined });
        return {};
      }
      if (f.method === "contextUsage") return { used: Math.round((sessions[c].context ?? 0.3) * 200_000), max: 200_000, parts: [{ name: "Разговор", tokens: 41_000 }, { name: "Инструменты", tokens: 18_400 }, { name: "Память и правила", tokens: 9_200 }, { name: "Серверы MCP", tokens: 6_100 }] };
      if (f.method === "mcpStatus") return { servers: [{ name: "fleet", status: "connected", tools: 24 }, { name: "playwright", status: "connected", tools: 21 }, { name: "github", status: "failed", error: "нет токена" }] };
      if (f.method === "tasks") return { tasks: sessions[c].state === "busy" ? [{ id: "bg1", desc: "npm run dev", type: "local_bash", started: now() - 9 * MIN }] : [] };
      if (f.method === "commands") return { commands: [{ name: "/compact", about: "Сжать контекст" }, { name: "/clear", about: "Начать разговор заново" }, { name: "/review", about: "Ревью текущих правок" }, { name: "/deliver", about: "Довести принятое до конца" }, { name: "/design", about: "Дизайн в персоне архитектора" }] };
      if (f.method === "models") return { models: [{ id: "claude-fable-5-2", name: "Fable 5.2" }, { id: "claude-opus-5-5", name: "Opus 5.5" }, { id: "claude-sonnet-5-5", name: "Sonnet 5.5" }, { id: "claude-haiku-5-5", name: "Haiku 5.5" }] };
      if (f.method === "rewindFiles") return { files: ["src/components/Header.tsx", "src/components/MenuButton.tsx", "src/styles/header.css"] };
      return {};
    },
    message: (f) => {
      const { c, s } = sess(f);
      emit(c, [say(f.text, now())]);
      if (s.state === "busy") return { queued: true };
      startLive(c, String(f.text).slice(0, 40));
      setRow(c, { state: "busy", doing: "Читает сообщение", unread: [], error: undefined });
      return {};
    },
    "session.history": (f) => {
      const all = talk(String(f.to));
      const end = f.before ? Math.max(0, all.findIndex((e) => e.uuid === f.before)) : all.length;
      const start = Math.max(0, end - (f.limit ?? 50));
      return { events: all.slice(start, end), more: start > 0, seq: all.length };
    },
    "session.files": (f) => ({ files: ["src/components/Header.tsx", "src/components/Footer.tsx", "src/lib/http.ts", "src/routes.ts", "package.json", "README.md"].filter((p) => p.toLowerCase().includes(String(f.q).toLowerCase())) }),
    "session.watch": (f) => (watched.add(String(f.to)), { seq: talk(String(f.to)).length }),
    "session.unwatch": (f) => (watched.delete(String(f.to)), {}),
    "session.read": (f) => (sessions[String(f.to)]?.unread?.includes(ME) && setRow(String(f.to), { unread: (sessions[String(f.to)].unread ?? []).filter((p) => p !== ME) }), {}),
    answer: (f) => {
      const { c, s } = sess(f);
      if (!s.ask || s.ask.id !== f.ask) throw new Refusal("already_answered", "на этот вопрос уже ответили");
      const said = typeof f.answer === "string" ? f.answer : JSON.stringify(f.answer);
      emit(c, [say(`Ответ: ${said}`, now(), { isMeta: false })]);
      if (/Отклонить|Доработать/.test(said)) setRow(c, { state: "idle", ask: null, unread: [] });
      else {
        startLive(c, s.title ?? "задача");
        setRow(c, { state: "busy", ask: null, doing: "Продолжает после ответа", unread: [] });
      }
      return {};
    },

    "account.list": (f) => ({ accounts: accounts[mach(f)] ?? [] }),
    "account.login": (f) => {
      const login = "l" + newId().slice(0, 6);
      logins.set(login, mach(f));
      return { login, url: "https://claude.ai/oauth/authorize?code=true&client_id=mock&state=" + login };
    },
    "account.code": (f) => {
      const m = need(logins.get(f.login), "вход не начат или истёк");
      if (String(f.code).length < 6) throw new Refusal("bad_code", "код не подошёл");
      const list = accounts[m];
      let a = list.find((x) => !x.ok);
      if (a) Object.assign(a, { ok: true, why: undefined, limits: lim(0.05, 0.71) });
      else list.push((a = { id: "new@example.com", kind: "claude", email: "new@example.com", plan: "Max 5x", limits: lim(0, 0), slot: list.length + 1, ok: true, sessions: 0 }));
      return { account: a };
    },
    "account.remove": (f) => {
      const list = accounts[mach(f)];
      list.splice(list.findIndex((a) => a.id === f.account), 1);
      return {};
    },
    "slot.set": (f) => {
      const list = accounts[mach(f)];
      (f.order as string[]).forEach((id, i) => {
        const a = list.find((x) => x.id === id);
        if (a) a.slot = i + 1;
      });
      list.sort((a, b) => (a.slot ?? 99) - (b.slot ?? 99));
      return {};
    },
    "key.check": (f) => (mach(f), { ok: true, word: "glm-abliterated ответила за 1,4 с" }),
    "profile.list": (f) => (mach(f), { pieces }),
    "profile.view": (f) => {
      mach(f);
      const items = (f.pieces as string[]).flatMap((p) => {
        const piece = pieces.find((x) => x.id === p);
        if (!piece?.ok) return [];
        return [
          { kind: "скил", name: p === "web" ? "shots" : p === "ops" ? "deploy" : "design", piece: p, about: p === "web" ? "Снимки экранов настоящего кода" : p === "ops" ? "Выкладка по шагам" : "Дизайн в персоне архитектора" },
          { kind: "скил", name: p === "web" ? "a11y" : p === "ops" ? "logs" : "deliver", piece: p, about: p === "web" ? "Проверка доступности" : p === "ops" ? "Разбор журналов" : "Довести принятое до конца" },
          ...(p === "base" ? [{ kind: "хук", name: "pre-commit", piece: p, about: "Гейт импортов перед коммитом" }, { kind: "настройка", name: "permissions", piece: p, about: "Разрешено всё, вопросы человеку — наружу" }] : []),
          ...(p === "web" ? [{ kind: "сервер MCP", name: "playwright", piece: p, about: "Браузер для снимков" }, { kind: "агент", name: "critic", piece: p, about: "Критик прототипа" }] : []),
        ];
      });
      return { items };
    },
    "profile.file": () => ({ text: "---\nname: deliver\ndescription: Доводит принятое до конца\n---\n\n# Порядок\n\n1. Код с тестами\n2. Выпуск и живой прогон\n3. Второй проход" }),
    "points.save": (f) => {
      const { c } = sess(f);
      const s = archive.find((a) => a.callsign === c);
      if (s) (s.points++, (s.last = now()));
      return { point: "p" + ((s?.points ?? 0) + 1) };
    },
    "points.raise": (f) => {
      const m = mach(f);
      const src = need(archive.find((a) => a.sid === f.sid), "такой сессии в архиве нет");
      const name = f.name ?? src.callsign.split("@")[0];
      const c = `${name}@${m}`;
      if (sessions[c]) throw new Refusal("name_taken", `сессия ${c} уже есть`);
      talks.set(c, [...talk(src.callsign)]);
      sessions[c] = row(c, "idle", src.project, { title: src.title, cwd: f.cwd ?? src.cwd, last: now(), since: now() });
      delta({ sessions: [{ callsign: c, row: sessions[c] }] });
      return { callsign: c };
    },
    "shell.info": (f) => ({ os: machines[mach(f)].os, shells: ["bash", "node"], home: "/home/yuri" }),
    "shell.run": (f) => (mach(f), { run: "r" + newId().slice(0, 5), state: "done", code: 0, out: "ok", started: now() - 800, ended: now() }),
    "incident.list": (f) => ({ incidents: incidents[mach(f)] ?? [] }),
    "machine.dirs": (f) => {
      mach(f);
      const path = f.path ?? "~/projects";
      return { path, dirs: path === "~/projects" ? ["site", "billing", "docs", "infra", "prices", "sandbox"] : ["src", "test", "scripts", "docs"], recent: ["~/projects/site", "~/projects/billing", "~/projects/docs", "~/projects/infra"], git: path !== "~/projects" };
    },
    "machine.journal": (f) => {
      const all = journal(mach(f)).filter((l) => (!f.level || l.level === f.level) && (!f.part || l.part === f.part) && (!f.of || l.trace === f.of));
      const p = page(all, f.before, f.limit ?? 40, (l) => l.t);
      return { lines: p.items, more: p.more };
    },
    "keeper.state": (f) => {
      const m = mach(f);
      return { build: machines[m].build, host: { build: machines[m].build, state: "running", since: machines[m].since }, os: machines[m].os };
    },

    "builds.list": () => builds,
    "builds.deploy": (f) => {
      if (f.machine) {
        if (f.build === null) delete builds.pins[f.machine];
        else builds.pins[f.machine] = f.build;
      } else builds.stable = f.build;
      ledger.unshift({ id: "e" + newId(), at: now(), what: "builds.deployed", who: MY_ADDR, text: f.machine ? `${f.machine} закреплена на сборке ${f.build ?? "флота"}` : `Сборка ${f.build} назначена флоту` });
      setTimeout(() => {
        const ms = Object.values(machines).filter((m) => m.online && (f.machine ? m.name === f.machine : !(m.name in builds.pins)));
        for (const m of ms) m.build = (f.machine ? f.build : builds.stable) ?? builds.stable ?? m.build;
        delta({ machines: ms });
      }, 1500);
      return {};
    },
    "ledger.read": (f) => {
      const all = ledger.filter((e) => (!f.what || e.what.startsWith(f.what)) && (!f.machine || e.machine === f.machine));
      const p = page(all, f.before, f.limit ?? 50, (e) => e.at);
      return { events: p.items, more: p.more };
    },
    "ledger.add": () => ({}),
    "points.list": (f) => {
      if (f.sid) {
        const s = need(archive.find((a) => a.sid === f.sid), "такой сессии в архиве нет");
        return { sessions: [s], points: archPoints(s), more: false };
      }
      const q = String(f.q ?? "").trim().toLowerCase();
      const found = archive.filter((a) => !f.machine || a.machine === f.machine).flatMap((a) => {
        if (!q) return [a];
        const line = talk(a.callsign).flatMap((e) => (e.type === "assistant" ? (e.message.content as any[]).filter((b) => b.type === "text").map((b) => String(b.text)) : typeof e.message?.content === "string" ? [e.message.content] : [])).flatMap((t) => t.split("\n")).find((l) => l.toLowerCase().includes(q));
        const hit = line ?? (a.title?.toLowerCase().includes(q) ? a.title : undefined);
        return hit ? [{ ...a, hit: hit.slice(0, 160) }] : [];
      });
      return { sessions: found.sort((a, b) => b.last - a.last), more: false };
    },
    "points.history": (f) => {
      const s = need(archive.find((a) => a.sid === f.sid), "такой сессии в архиве нет");
      const all = talk(s.callsign).length ? talk(s.callsign) : shortTurn(s.last - 20 * MIN, "Продолжи с прошлого раза.", `Работа по «${s.title}» доведена до точки. Тесты зелёные.`);
      return { events: all, more: false };
    },
    "points.delete": (f) => (archive.splice(archive.findIndex((a) => a.sid === f.sid), 1), {}),
    "reach.devices": () => ({ devices }),
    "reach.key": () => ({ key: "BMockVapidPublicKey" }),
    "reach.subscribe": (f) => (devices.push({ id: "d" + newId().slice(0, 4), kind: "webpush", person: ME, label: f.label ?? "Этот браузер", at: now() }), { id: devices.at(-1)!.id }),
    "reach.remove": (f) => (devices.splice(devices.findIndex((d) => d.id === f.device), 1), {}),
    "reach.telegram": () => ({ code: "SB-" + newId().slice(0, 6).toUpperCase(), bot: "switchboard_fleet_bot" }),
    "reach.send": () => ({ sent: 0, online: true }),
    "prefs.get": (f) => ({ values: Object.fromEntries(Object.entries(prefs[f.scope as "me" | "fleet"]).filter(([k]) => !f.prefix || k.startsWith(f.prefix))) }),
    "prefs.set": (f) => {
      const store = prefs[f.scope as "me" | "fleet"];
      if (f.patch) {
        const next = { ...((store[f.name] as object) ?? {}), ...f.patch } as Record<string, unknown>;
        for (const k of Object.keys(next)) if (next[k] === null) delete next[k];
        store[f.name] = next;
      } else store[f.name] = f.value;
      return {};
    },
    "keys.list": () => ({ keys }),
    "keys.set": (f) => {
      const k = keys.find((x) => x.name === f.name);
      const next = { name: f.name, provider: f.provider, base: f.base, model: f.model, at: now(), tail: "…" + String(f.value).slice(-4) };
      if (k) Object.assign(k, next);
      else keys.push(next);
      return {};
    },
    "keys.remove": (f) => (keys.splice(keys.findIndex((k) => k.name === f.name), 1), {}),
    "github.app": () => ({ installed: true, name: "switchboard-fleet", url: "https://github.com/apps/switchboard-fleet", repos: ["example/sb-base", "example/sb-web", "example/sb-ops"] }),
    "github.setup": () => ({ installed: true }),
    "analytics.query": (f) => {
      if (analyticsDown) throw new Refusal("analytics_unavailable", "ClickHouse не ответил за 10 с");
      const days = Math.max(1, Math.round((Date.parse(f.until) - Date.parse(f.since)) / DAY) + 1);
      const mk = (key: string, w: number, i: number) => ({ key, calls: Math.round(w * (120 + i * 17)), input: Math.round(w * 2.1e6), output: Math.round(w * 4.2e5), cacheRead: Math.round(w * 2.6e7), cacheWrite: Math.round(w * 3.1e6), cost: Math.round(w * 38.4 * 100) / 100 });
      if (f.by === "day") return { rows: Array.from({ length: days }, (_, i) => mk(new Date(Date.parse(f.since) + i * DAY).toISOString().slice(0, 10), 0.5 + ((i * 37) % 11) / 9, i)) };
      const KEYS: Record<string, Array<[string, number]>> = {
        model: [["claude-fable-5-2", 4.2], ["claude-sonnet-5-5", 1.6], ["claude-opus-5-5", 0.9], ["glm-abliterated", 0.3]],
        machine: [["server", 3.1], ["laptop", 2.7], ["anya-pc", 1.0], ["base2", 0.2]],
        session: [["ingest@server", 1.4], ["site@laptop", 1.2], ["lead@laptop", 0.9], ["nightcheck@server", 0.8], ["landing@anya-pc", 0.7], ["deploy@server", 0.5], ["docs@laptop", 0.4]],
        person: [["~yuri@example.com", 5.6], ["~anya@example.com", 1.2], ["~oleg@example.com", 0.2]],
        project: [["infra", 3.0], ["site", 2.8], ["research", 1.2]],
      };
      return { rows: KEYS[f.by].map(([k, w], i) => mk(k, (w * days) / 7, i)) };
    },
    "obs.recent": (f) => {
      const all = obs.filter((r) => (!f.name || r.type.startsWith(f.name)) && (!f.failed || !r.ok) && (!f.of || r.trace === f.of));
      const p = page(all, f.before, f.limit ?? 60, (r) => r.at);
      return { rows: p.items, more: p.more };
    },
    "obs.stats": (f) => {
      const inRange = obs.filter((r) => r.at >= f.since && r.at <= f.until);
      const by = new Map<string, number[]>(), bad = new Map<string, number>();
      for (const r of inRange) {
        (by.get(r.type) ?? (by.set(r.type, []), by.get(r.type)!)).push(r.ms);
        if (!r.ok) bad.set(r.type, (bad.get(r.type) ?? 0) + 1);
      }
      const q = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))];
      const step = Math.max(MIN, (f.until - f.since) / 24);
      const buckets = Array.from({ length: 24 }, (_, i) => {
        const a = f.since + i * step, rows = inRange.filter((r) => r.at >= a && r.at < a + step);
        return { at: a, n: rows.length, failed: rows.filter((r) => !r.ok).length };
      });
      return { types: [...by].map(([type, ms]) => ({ type, n: ms.length, failed: bad.get(type) ?? 0, p50: q(ms, 0.5), p95: q(ms, 0.95) })).sort((a, b) => b.n - a.n), buckets };
    },
    "obs.report": () => ({}),
  };

  const SPANS: Record<string, string[]> = { session: ["services", "platform", "host"], machine: ["services", "platform", "host"], fleet: ["services", "platform"] };
  const call = async (f: Frame): Promise<Reply> => {
    await new Promise((r) => setTimeout(r, latency));
    const t0 = now();
    const h = H[f.type];
    const kind = typeof f.to === "string" ? (f.to.startsWith("@") || f.to.startsWith(".") ? "machine" : f.to.includes("@") && !f.to.includes("~") ? "session" : "fleet") : "service";
    const parts = SPANS[kind] ?? ["services", f.type.split(".")[0]];
    const spans: Span[] = parts.map((part, i) => ({ part, ms: i === parts.length - 1 ? 8 + (f.type.length % 5) * 9 : 2 + (i % 2) }));
    let r: Reply;
    try {
      if (!h) throw new Refusal("unknown_request", `${f.type} здесь не обслуживается`);
      r = ok(f.id!, h(f));
    } catch (e) {
      r = e instanceof Refusal ? fail(f.id!, e.word, e.why) : fail(f.id!, "module_failed", e instanceof Error ? e.message : String(e));
    }
    r.trace = f.trace;
    r.spans = spans;
    if (!f.type.startsWith("obs.")) obs.unshift({ trace: f.trace ?? newId("t"), at: t0, type: f.type, from: MY_ADDR, ...(typeof f.to === "string" ? { to: f.to } : {}), ok: r.ok, ...(r.ok ? {} : { word: r.error, why: r.why }), ms: spans.reduce((a, s) => a + s.ms, 0), spans });
    return r;
  };

  const transport: Transport = {
    call,
    open(role, opts): Link {
      opts.onState?.("connecting");
      if (role === "page") {
        const on = opts.onFrame;
        const t = setTimeout(() => (pages.add(on), opts.onState?.("open"), on(snapshot())), 30);
        return { send() {}, close: () => (clearTimeout(t), pages.delete(on), void 0) };
      }
      const w = { machine: opts.machine!, on: opts.onFrame };
      watchers.add(w);
      setTimeout(() => opts.onState?.("open"), 10);
      return { send() {}, close: () => void watchers.delete(w) };
    },
  };

  return {
    transport,
    /** рычаги для снимков и тестов */
    tick,
    stop: () => timer && clearInterval(timer),
    setAnalyticsDown: (v: boolean) => (analyticsDown = v),
    setMachineOnline(name: string, online: boolean) {
      machines[name] = { ...machines[name], online, since: now() };
      delta({ machines: [machines[name]] });
    },
    state: { sessions, machines, people, projects, passes, archive, obs },
  };
}

export type Mock = ReturnType<typeof createMock>;
