// Мок флота: провод договора в памяти страницы. Живой: занятые сессии пишут события, ответ на вопрос меняет состояние, записи видны сразу.
import {
  type Account, type Slot, type ArchPoint, type ArchSession, type Ask, type DeviceRow, type Frame, type Incident, type KeyRow, type LedgerEvent, type Link, type MachineRow,
  type ObsRow, type PassRow, type PersonRow, type Piece, type Project, type Reply, type SessionRow, type Span, type Transport, fail, machineOf, newId, ok, Refusal,
} from "@sb/protocol";
import { iter2Handlers } from "./iter2.ts";
import { iter4Handlers } from "./iter4.ts";
import { screenHandlers } from "./screens.ts";
import { done, type Ev, got, liveSteps, peer, reply, researchTurn, say, shortTurn, siteTurn, text, uid, use } from "./convo.ts";

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
  // вопрос адресован тому, кто дал задачу; видели его те, кто смотрел сессию
  const ask = (a: Omit<Ask, "id" | "at">, minAgo: number): Ask => ({ id: uid("q"), at: T - minAgo * MIN, to: ME, seen: [MY_ADDR, "phone" + ME], ...a });
  const row = (callsign: string, state: SessionRow["state"], project: string | undefined, r: Partial<SessionRow> & { cwd?: string; model?: string; pieces?: string[]; mode?: SessionRow["spec"]["mode"] } = {}): SessionRow => {
    const { cwd, model, pieces, mode, ...rest } = r;
    const name = callsign.slice(0, callsign.indexOf("@"));
    return {
      callsign, state, by: ME, since: T - 8 * HOUR, last: T - 30 * MIN,
      spec: { name, cwd: cwd ?? `~/projects/${name}`, model: model ?? M, effort: "high", mode: mode ?? "all", slot: "main", pieces: pieces ?? ["base"], backup: true, ...(project ? { project } : {}) },
      account: "yuri@example.com", context: 0.31, ...rest,
    };
  };
  const sessions: Record<string, SessionRow> = {};
  const add = (r: SessionRow) => (sessions[r.callsign] = r);

  add(row("site@laptop", "busy", "site", { title: "Шапка сайта на узких экранах", doing: "Правит src/components/Header.tsx", pieces: ["base", "web"], last: T - 1 * MIN, context: 0.42 }));
  add(row("site-tests@laptop", "waiting", "site", { title: "Выкладка тестового стенда", pieces: ["base", "web"], last: T - 6 * MIN,
    ask: ask({ kind: "question", title: "Ветка для выкладки", text: "Какую ветку выкладывать на тестовый стенд?", tool: "AskUserQuestion", options: [{ label: "main", about: "последний зелёный коммит" }, { label: "release/2.4", about: "ветка выпуска" }, { label: "Обе по очереди" }] }, 6) }));
  add(row("docs@laptop", "idle", "site", { title: "Раздел про выкладку в документации", unread: [ME], last: T - 14 * MIN, context: 0.18, result: "Дописал раздел «Выкладка»: три шага, откат и пример. Проверил ссылки в разделе — 14 из 14 открываются." }));
  add(row("lead@laptop", "busy", "research", { title: "Замена клиента оплаты", doing: "Ждёт итог от wing@laptop", last: T - 2 * MIN, spec: { name: "lead", cwd: "~/projects/billing", model: M, effort: "xhigh", mode: "all", slot: "main", pieces: ["base", "research"], wing: "wing@laptop", project: "research", backup: true } }));
  add(row("wing@laptop", "busy", "research", { title: "Поиск вызовов старого клиента", doing: "Читает src/jobs/renew.ts", by: "lead@laptop", lead: "lead@laptop", last: T - 1 * MIN, model: "claude-sonnet-5-5", spec: { name: "wing", cwd: "~/projects/billing", model: "claude-sonnet-5-5", effort: "medium", mode: "all", slot: "main", pieces: ["base"], parent: "lead@laptop", project: "research", backup: true } }));
  // четыре больших вопроса разом: карточка на каждый, всё прокручивается вместе с лентой
  const longQ = (about: string, n: number) => `${about}\n\n` + Array.from({ length: n }, (_, i) => `${i + 1}. ${["Проверил текущую схему и её ограничения", "Сравнил с тем, что уже лежит в репозитории", "Посчитал, сколько файлов это затронет", "Оценил, что сломается у соседних команд", "Нашёл место, где это решение уже пробовали"][i % 5]} — пункт ${i + 1} разбора, от которого зависит ответ.`).join("\n");
  add(row("survey@laptop", "waiting", "site", { title: "Перенос сайта на новую сборку", last: T - 5 * MIN, pieces: ["base", "web"],
    ask: ask({ kind: "question", title: "Перенос сайта", text: "Четыре решения перед переносом", tool: "AskUserQuestion", input: { questions: [
      { header: "Сборщик", question: longQ("**Какой сборщик берём?** Ниже — что я выяснил по каждому.", 32), options: [{ label: "Vite", description: "уже стоит в соседнем проекте, сборка 3 с" }, { label: "Rspack", description: "совместим с нынешним конфигом, сборка 5 с" }, { label: "Оставить webpack", description: "ничего не трогаем, сборка 48 с" }] },
      { header: "Порядок", question: longQ("**В каком порядке переносим разделы?** Зависимости между ними:", 34), options: [{ label: "Сначала каталог", description: "самый большой, но без общих стилей" }, { label: "Сначала корзина", description: "маленькая, зато задевает оплату" }, { label: "Всё одним заходом", description: "один большой дифф на 400 файлов" }] },
      { header: "Проверки", question: longQ("**Что прогонять после каждого шага?** Можно несколько.", 31), multiSelect: true, options: [{ label: "Тесты", description: "214 штук, 40 с" }, { label: "Снимки экранов", description: "62 экрана, 3 мин" }, { label: "Проверка ссылок", description: "1 900 ссылок, 6 мин" }, { label: "Замер скорости", description: "5 страниц, 2 мин" }] },
      { header: "Откат", question: longQ("**Как откатываемся, если после переноса что-то сломалось?**", 30), options: [{ label: "Веткой", description: "старая сборка живёт в ветке до конца недели" }, { label: "Флагом", description: "обе сборки в коде, переключатель в настройках" }] },
    ] } }, 5) }));
  // «активно всё»: идёт ход с тремя субагентами и фоновой командой, и тут же ждёт разрешения
  add(row("audit@server", "waiting", "infra", { title: "Проверка прав доступа по службам", doing: "Ждёт трёх субагентов", last: T - 1 * MIN, context: 0.71, pieces: ["base", "ops"],
    ask: ask({ kind: "permission", title: "Команда", text: "grep -rn \"role\" /etc/services.d", tool: "Bash", input: { command: "grep -rn \"role\" /etc/services.d", description: "Роли в настройках служб" }, rule: "Bash(grep -rn *)", blocked: "/etc/services.d", notes: "Папка вне проекта", options: [{ label: "allow" }, { label: "allow_always" }, { label: "deny" }] }, 1) }));
  add(row("hotfix@laptop", "failed", "site", { title: "Срочная правка формы входа", error: "процесс claude дважды вышел до готовности: код 1, «Invalid API key»", last: T - 50 * MIN, account: "work@example.com" }));
  add(row("deploy@server", "waiting", "infra", { title: "Пересборка и выкладка статики", mode: "ask", last: T - 3 * MIN, pieces: ["base", "ops"],
    ask: ask({ kind: "permission", title: "Команда", text: "rm -rf dist && npm run build", tool: "Bash", input: { command: "rm -rf dist && npm run build", description: "Чистая пересборка" }, rule: "Bash(rm -rf dist *)", blocked: "~/projects/site/dist", notes: "Команда удаляет папку вне списка разрешённых правил проекта", options: [{ label: "allow" }, { label: "allow_always" }, { label: "deny" }] }, 3) }));
  add(row("api@server", "waiting", "infra", { title: "Предел запросов на входе", mode: "plan", last: T - 22 * MIN, pieces: ["base", "ops"],
    ask: ask({ kind: "plan", title: "План", text: "## Предел запросов на входе\n\n1. Счётчик на адрес в памяти процесса, окно 10 секунд.\n2. Отказ `429` со словом `too_many` и временем сброса.\n3. Тесты: 3 сценария — ровно на пределе, сверх предела, после сброса.\n\nФайлы: `src/entrance.ts`, `src/limit.ts`, `test/limit.test.ts`.", tool: "ExitPlanMode", options: [{ label: "allow" }, { label: "allow_always" }, { label: "deny" }] }, 22) }));
  add(row("ingest@server", "busy", "infra", { title: "Разбор ночной выгрузки", doing: "Выполняет node scripts/ingest.mjs", last: T - 1 * MIN, context: 0.67, pieces: ["base", "ops"] }));
  add(row("nightcheck@server", "idle", "infra", { title: "Ночная проверка флота", wait: T + 95 * MIN, incident: { kind: "disk", key: "/var" }, last: T - 7 * HOUR, by: "~yuri@example.com", pieces: ["base", "ops"] }));
  add(row("migrate@server", "stopped", "infra", { title: "Перенос журналов в архив", archiveError: "архив не ответил: store_failed", last: T - 2 * DAY, pieces: ["base"] }));
  add(row("landing@anya-pc", "busy", "site", { title: "Новый первый экран", doing: "Собирает снимки на 390 и 1440", by: ANYA, last: T - 2 * MIN, account: "anya@example.com", pieces: ["base", "web"] }));
  add(row("design@anya-pc", "idle", "site", { title: "Палитра и сетка", by: ANYA, unread: [ME, ANYA], result: "Тёмный вариант готов: фон #0F1413, контраст 11,4 : 1. Оба варианта лежат рядом, выберите один.", last: T - 41 * MIN, account: "anya@example.com", pieces: ["base", "web"] }));
  add(row("forms@anya-pc", "waiting", "site", { title: "Форма заявки", by: ANYA, last: T - 9 * MIN, account: "anya@example.com", pieces: ["base", "web"],
    ask: ask({ kind: "form", title: "Доступ к почтовому серверу", text: "Нужны данные почтового сервера для отправки заявок.", schema: { type: "object", required: ["host", "user"], properties: { host: { type: "string", title: "Сервер" }, port: { type: "number", title: "Порт", default: 587 }, user: { type: "string", title: "Пользователь" } } } }, 9) }));
  add(row("crawler@base2", "busy", "research", { title: "Сбор цен конкурентов", doing: "Обходит каталог цен", last: T - 3 * HOUR, pieces: ["base", "research"] }));
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
  talk("survey@laptop").push(say("Перенеси сайт на новую сборку. Перед началом спроси, что нужно решить.", T - 9 * MIN), reply([text("Собрал четыре решения, без которых перенос не начать.")], T - 5 * MIN));
  // идут сейчас: три субагента с шагами и фоновая команда — блок над полем ввода
  talk("audit@server").push(
    say("Проверь права доступа в трёх службах и скажи, где они шире нужного.", T - 8 * MIN),
    reply([text("Раздаю проверку трём субагентам, сам слежу за журналом входа."), use("ag1", "Agent", { description: "Права службы оплаты", subagent_type: "Explore", prompt: "Пройди services/billing: какие роли что могут, где права шире нужного." }), use("ag2", "Agent", { description: "Права службы каталога", subagent_type: "Explore", prompt: "Пройди services/catalog: роли и их права." }), use("ag3", "Agent", { description: "Сводка по ролям", subagent_type: "general-purpose", prompt: "Собери таблицу ролей по трём службам из docs/roles." })], T - 7 * MIN),
    ...[["ag1", "t-ag1", "Права службы оплаты", 6], ["ag2", "t-ag2", "Права службы каталога", 5], ["ag3", "t-ag3", "Сводка по ролям", 4]].map(([tool, id, desc, min]) => ({ type: "system", subtype: "task_started", uuid: uid("s"), task_id: id, tool_use_id: tool, description: desc, task_type: "local_agent", is_backgrounded: false, timestamp: new Date(T - (min as number) * MIN).toISOString() }) as Ev),
    reply([use("ag1-a", "Grep", { pattern: "role:", path: "services/billing" })], T - 6 * MIN, "ag1"), got("ag1-a", "services/billing/src/roles.ts:14\nservices/billing/src/refund.ts:8", T - 6 * MIN + 4000, "ag1"),
    reply([use("ag1-b", "Read", { file_path: "services/billing/src/refund.ts" })], T - 5 * MIN, "ag1"), got("ag1-b", "export const canRefund = (r: Role) => r !== \"guest\";", T - 5 * MIN + 3000, "ag1"),
    reply([use("ag2-a", "Glob", { pattern: "services/catalog/**/*.ts" })], T - 4 * MIN, "ag2"), got("ag2-a", "services/catalog/src/index.ts\nservices/catalog/src/acl.ts", T - 4 * MIN + 2000, "ag2"),
    { type: "system", subtype: "task_progress", uuid: uid("s"), task_id: "t-ag1", last_tool_name: "Read", usage: { tool_uses: 12 } } as Ev,
    { type: "system", subtype: "task_progress", uuid: uid("s"), task_id: "t-ag2", last_tool_name: "Glob", usage: { tool_uses: 7 } } as Ev,
    { type: "system", subtype: "task_progress", uuid: uid("s"), task_id: "t-ag3", summary: "сводит роли службы оплаты", usage: { tool_uses: 3 } } as Ev,
    { type: "system", subtype: "task_started", uuid: uid("s"), task_id: "bg-audit", description: "tail -f /var/log/auth.log", task_type: "local_bash", is_backgrounded: true, timestamp: new Date(T - 7 * MIN).toISOString() } as Ev,
  );
  talk("hotfix@laptop").push(say("Форма входа падает при пустом пароле. Почини срочно.", T - 55 * MIN));
  talk("deploy@server").push(...shortTurn(T - 25 * MIN, "Какая сборка статики сейчас на сервере?", "На сервере сборка от вчера, 18:40, коммит `a41f9c2`."), say("Пересобери с нуля и выложи.", T - 4 * MIN), reply([text("Начну с чистой пересборки.")], T - 3 * MIN));
  talk("api@server").push(say("Добавь предел запросов на входе. Сначала план.", T - 26 * MIN), reply([text("Составил план, жду решения.")], T - 22 * MIN));
  talk("ingest@server").push(say("Разбери ночную выгрузку и скажи, сколько строк не прошло проверку.", T - 12 * MIN));
  // фоновая задача сессии: видна в доке над вводом, у неё есть вывод и «Стоп»
  talk("ingest@server").push({ type: "system", subtype: "task_started", uuid: uid("s"), task_id: "bg1", description: "npm run dev", task_type: "local_bash", is_backgrounded: true, timestamp: new Date(T - 9 * MIN).toISOString() } as Ev);
  talk("nightcheck@server").push(...shortTurn(T - 7 * HOUR, "Проверь флот: все ли машины на последней сборке.", "Три машины из четырёх на сборке 412. `base2` — на 410 и без связи с 02:10."));
  talk("migrate@server").push(...shortTurn(T - 2 * DAY, "Перенеси журналы старше 30 дней в архив.", "Перенесено 1 284 файла, 3,1 ГБ. Сессию можно останавливать."));
  talk("landing@anya-pc").push(say("Собери первый экран по макету из design@anya-pc.", T - 20 * MIN));
  talk("design@anya-pc").push(...shortTurn(T - 90 * MIN, "Предложи палитру и сетку для сайта.", "Палитра из пяти цветов и сетка на 12 колонок — в `design/tokens.json`. Контраст текста 7,2 : 1."), ...shortTurn(T - 42 * MIN, "Сделай вариант темнее.", "Тёмный вариант готов: фон `#0F1413`, контраст 11,4 : 1. Оба варианта лежат рядом, выберите один."));
  talk("forms@anya-pc").push(say("Форма заявки должна слать письмо менеджеру.", T - 10 * MIN), reply([text("Для отправки нужны данные почтового сервера.")], T - 9 * MIN));
  talk("crawler@base2").push(say("Собери цены конкурентов по списку из prices/sources.txt.", T - 5 * HOUR));
  talk("backup@base2").push(...shortTurn(T - 9 * HOUR, "Проверь, что ночные копии читаются.", "Копии за 7 ночей читаются, размеры от 1,9 до 2,2 ГБ."));

  const live = new Map<string, Live>();
  /** сообщения, которые ждут конца идущего хода */
  const queue = new Map<string, Array<{ uuid: string; text: string; from: string; at: number; event: Ev }>>();
  /** сессии, которые уберутся после хода */
  const removeAfter = new Set<string>();
  /** серверы MCP, выключенные человеком */
  const mcpOff = new Set<string>();
  const startLive = (c: string, about: string, then?: () => void) => live.set(c, { steps: liveSteps(now, about), then });
  startLive("site@laptop", "подвал сайта");
  startLive("ingest@server", "ночная выгрузка");
  startLive("landing@anya-pc", "первый экран");
  startLive("wing@laptop", "поиск вызовов");

  /* ===== Остальные записи ===== */
  // числа как у Claude: неделя целиком и лимит Fable; у недели — доля Fable в ней и запас для него. fable и other — сколько недели потратили Fable и остальные модели.
  const CAP = 0.5, NEAR = 0.98;
  const lim = (fable: number, other: number, days = 3.2) => {
    const week = Math.min(1, fable + other), hold = Math.max(0, Math.min(CAP - fable, 1 - week));
    return [{ name: "five_hour", used: 0.4, resets: T + 2 * HOUR }, { name: "seven_day", used: week, fable, hold, resets: T + days * DAY }, { name: "fable", used: Math.min(1, fable / CAP), resets: T + days * DAY }];
  };
  type LaneName = "fable" | "other";
  const laneOf = (model?: string): LaneName => (!model || /fable/i.test(model) ? "fable" : "other");
  const limOf = (a: Account | undefined, name: string) => a?.limits?.find((l) => l.name === name);
  /** Аккаунт годен месту: Fable — пока не выбран ни его лимит, ни неделя; остальным моделям — пока есть неделя сверх запаса Fable. */
  const fits = (a: Account | undefined, lane: LaneName) => {
    if (!a?.ok) return false;
    const week = limOf(a, "seven_day");
    return lane === "fable" ? (limOf(a, "fable")?.used ?? 0) < NEAR && (week?.used ?? 0) < NEAR : (week?.used ?? 0) + (week?.hold ?? 0) < NEAR;
  };
  /** Места очереди, как их ставит Host. Fable — первый по порядку с запасом Fable. Остальные — первый с неделей сверх запаса Fable;
   *  таких нет — берут запас Fable, с конца порядка. Годного нет — место ждёт недельного сброса. Место не уходит с аккаунта, пока он ему годен. */
  const place = (q: Slot, list: Account[]) => {
    const by = (id?: string) => list.find((a) => a.id === id);
    const stay = (lane: LaneName, as: LaneName = lane) => { const was = q.lanes[lane].account; return was && q.order.includes(was) && fits(by(was), as) ? was : undefined; };
    const idle = (lane: LaneName) => {
      const was = q.lanes[lane].account, wait = Math.min(...q.order.map((id) => limOf(by(id), "seven_day")?.resets ?? Infinity));
      return { ...(was && q.order.includes(was) ? { account: was } : {}), ...(Number.isFinite(wait) ? { wait } : {}) };
    };
    const fable = stay("fable") ?? q.order.find((id) => fits(by(id), "fable"));
    const other = stay("other") ?? q.order.find((id) => fits(by(id), "other"));
    const spare = other ? undefined : ((q.lanes.other.over ? stay("other", "fable") : undefined) ?? [...q.order].reverse().find((id) => fits(by(id), "fable")));
    q.lanes = { fable: fable ? { account: fable } : idle("fable"), other: other ? { account: other } : spare ? { account: spare, over: true } : idle("other") };
  };
  const accounts: Record<string, Account[]> = {
    laptop: [
      { id: "yuri@example.com", kind: "claude", email: "yuri@example.com", plan: "Max 20x", limits: lim(0.37, 0.1), ok: true, sessions: 4 },
      { id: "work@example.com", kind: "claude", email: "work@example.com", plan: "Max 5x", limits: lim(0.495, 0.43, 5.4), ok: true, sessions: 1 },
      { id: "team@example.com", kind: "claude", email: "team@example.com", plan: "Max 5x", limits: lim(0.36, 0.64, 1.9), ok: false, why: "вход устарел: войдите заново", sessions: 0 },
      { id: "orca-glm", kind: "key", ok: true, sessions: 0 },
    ],
    server: [
      { id: "yuri@example.com", kind: "claude", email: "yuri@example.com", plan: "Max 20x", limits: lim(0.37, 0.1), ok: true, sessions: 3 },
      { id: "ops@example.com", kind: "claude", email: "ops@example.com", plan: "Max 5x", limits: lim(0.23, 0.49, 0.9), ok: true, sessions: 2 },
    ],
    "anya-pc": [{ id: "anya@example.com", kind: "claude", email: "anya@example.com", plan: "Max 5x", limits: lim(0.2, 0.49, 0.3), ok: true, sessions: 3 }],
    base2: [],
  };
  /** Очереди аккаунтов машин: один аккаунт может стоять в нескольких. */
  const slots: Record<string, Slot[]> = {
    // main на laptop: Fable стоит на yuri (у work его лимит выбран), остальные модели — на work; review — из одного work: Fable ждёт сброса
    laptop: [{ name: "main", order: ["work@example.com", "yuri@example.com", "team@example.com"], lanes: { fable: { account: "yuri@example.com" }, other: { account: "work@example.com" } }, sessions: 4 }, { name: "review", order: ["work@example.com"], lanes: { fable: { account: "work@example.com" }, other: { account: "work@example.com" } }, sessions: 1 }],
    server: [{ name: "main", order: ["yuri@example.com", "ops@example.com"], lanes: { fable: { account: "yuri@example.com" }, other: { account: "yuri@example.com" } }, sessions: 3 }, { name: "night", order: ["night@example.com", "ops@example.com"], lanes: { fable: { account: "night@example.com" }, other: { account: "night@example.com" } }, sessions: 2 }],
    // anya-pc: остальные модели выбрали свою половину на единственном аккаунте и идут из запаса Fable
    "anya-pc": [{ name: "main", order: ["anya@example.com"], lanes: { fable: { account: "anya@example.com" }, other: { account: "anya@example.com", over: true } }, sessions: 3 }],
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
  const POINT_LABELS = ["Задача принята, план из трёх шагов", "Найдена причина: стили меню на узких экранах", "Правка внесена, тесты 5 из 6", "Тесты 6 из 6, снимки приложены", "Ревью: два замечания исправлены", "Раздел дописан, ссылки проверены", "Откат правки: ломала вход", "Вторая попытка: тесты зелёные", "Выложено на тестовый стенд", "Готово: итог отправлен"];
  /** Точка называется тем, чем закончился ход. */
  const archPoints = (s: ArchSession): ArchPoint[] => Array.from({ length: s.points }, (_, i) => ({ point: `p${i + 1}`, at: s.last - (s.points - 1 - i) * 47 * MIN, turns: 2 + i * 3, bytes: 60_000 + i * 41_000, label: POINT_LABELS[(i + (s.points > POINT_LABELS.length ? 0 : POINT_LABELS.length - s.points)) % POINT_LABELS.length], git: (0xa41f9c2 + i * 7919).toString(16).slice(0, 7) }));
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
  /** Весть ведущему от ведомого: тем же сообщением, что и итог хода. */
  const tellLead = (wing: string, words: string) => {
    const lead = sessions[wing]?.lead;
    if (lead && sessions[lead]) emit(lead, [{ type: "user", uuid: uid("w"), from: wing, timestamp: new Date(now()).toISOString(), message: { role: "user", content: words } } as Ev]);
  };
  /** последние события ленты по сессиям: из них дочитывается пропущенное */
  const recent = new Map<string, Ev[]>();
  const FEED_ONLY = new Set(["message.status", "prompt_suggestion"]);
  const emit = (c: string, given: Ev[], feedOnly = false) => {
    // Host метит каждое событие временем машины: у живых событий SDK своего времени нет
    const events = given.map((e) => ("timestamp" in e || "at" in e ? e : ({ ...e, at: now() } as Ev)));
    // в разговор идут записи SDK; статусы и подсказки — только в ленту, как у Host
    if (!feedOnly) talk(c).push(...events.filter((e) => !FEED_ONLY.has(e.type)));
    recent.set(c, [...(recent.get(c) ?? []), ...events].slice(-200));
    const seq = (seqs.get(c) ?? 0) + events.length;
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
        const next = queue.get(c)?.shift();
        if (next) {
          // очередь: ход взял следующее сообщение, работа продолжается
          talk(c).push(next.event);
          emit(c, [{ type: "message.status", uuid: next.uuid, status: "taken" } as Ev]);
          startLive(c, next.text.slice(0, 40));
          setRow(c, { doing: "Читает сообщение из очереди", last: now() });
        } else if (removeAfter.delete(c)) setRow(c, null);
        else {
          setRow(c, { state: "idle", doing: undefined, last: now(), unread: watched.has(c) ? [] : [ME], ...(said ? { result: said.replace(/[`*#|]/g, "").slice(0, 200) } : {}) });
          emit(c, [{ type: "prompt_suggestion", suggestion: "Покажи, что изменилось в файлах" } as Ev]);
        }
        l.then?.();
      } else if (tool) setRow(c, { doing: DOING[tool.name]?.(tool.input) ?? tool.name });
    }
  };
  const timer = o.live === false ? null : setInterval(tick, 1600);

  /** Снять своё сообщение с очереди: его ещё не взял ход. */
  const cancelQueued = (c: string, uuid: unknown) => {
    const list = queue.get(c) ?? [];
    const i = list.findIndex((m) => m.uuid === uuid);
    if (i < 0) return { cancelled: false };
    list.splice(i, 1);
    emit(c, [{ type: "message.status", uuid, status: "cancelled" } as Ev]);
    return { cancelled: true };
  };

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
    "project.set": (f) => {
      const p = projects.find((x) => x.id === f.project);
      if (p) Object.assign(p, { name: f.name, ...(f.members ? { members: f.members } : {}) });
      else projects.push({ id: f.project, name: f.name, members: f.members ?? [ME] });
      return {};
    },
    "project.remove": (f) => (projects.splice(projects.findIndex((p) => p.id === f.project), 1), {}),

    "session.open": (f) => {
      const m = mach(f);
      let name = String(f.spec.name);
      if (f.number) for (let i = 1; sessions[`${name}@${m}`]; i++) name = `${f.spec.name}-${i}`;
      const c = `${name}@${m}`;
      if (sessions[c]) throw new Refusal("name_taken", `сессия ${c} уже есть`);
      if (!f.mkdir && /nope|нет-такой/.test(String(f.spec.cwd))) throw new Refusal("bad_input", `spec.cwd: папка не найдена — ${f.spec.cwd}`);
      const wing = f.pair ? `${name}-wing@${m}` : undefined;
      sessions[c] = { callsign: c, state: "starting", spec: { mode: "all", slot: "main", pieces: ["base"], backup: true, ...f.spec, name, ...(wing ? { wing } : {}) }, by: MY_ADDR, since: now(), last: now(), account: slots[m]?.find((q) => q.name === (f.spec.slot ?? "main"))?.lanes[laneOf(f.spec.model)].account, context: 0.02, ...(f.prompt ? { title: String(f.prompt).slice(0, 60) } : {}) };
      if (f.resume) talks.set(c, [...shortTurn(now() - 30 * MIN, "Продолжим с прошлого раза.", `Разговор ${f.resume} продолжен${f.fork ? " копией" : ""}.`)]);
      delta({ sessions: [{ callsign: c, row: sessions[c] }] });
      if (wing) {
        sessions[wing] = { callsign: wing, state: "idle", spec: { ...sessions[c].spec, name: `${name}-wing`, wing: undefined, parent: c }, by: c, lead: c, since: now(), last: now(), account: accounts[m]?.[0]?.id, context: 0.02 };
        delta({ sessions: [{ callsign: wing, row: sessions[wing] }] });
      }
      setTimeout(() => {
        if (!sessions[c]) return;
        if (f.prompt) {
          emit(c, [say(f.prompt, now())]);
          startLive(c, String(f.prompt).slice(0, 40));
          setRow(c, { state: "busy", doing: "Читает задачу" });
        } else setRow(c, { state: "idle" });
      }, 1200);
      return { callsign: c, ...(wing ? { wing } : {}) };
    },
    "session.update": (f) => {
      const { c, s } = sess(f);
      const patch = { ...f.patch };
      // как Host: сессия идёт на месте своей модели — сменилась модель или очередь, аккаунт берётся с нового места
      const inSlot = slots[machineOf(c) ?? ""]?.find((q) => q.name === (patch.slot ?? s.spec.slot));
      if (inSlot && ("model" in patch || "slot" in patch)) setRow(c, { account: inSlot.lanes[laneOf(patch.model ?? s.spec.model)].account });
      let wing: string | undefined;
      if (patch.wing === null) {
        const was = s.spec.wing;
        delete patch.wing;
        const spec = { ...s.spec, ...patch };
        delete spec.wing;
        setRow(c, { spec });
        // как Host: снятый ведомый убирается с машины
        if (was && sessions[was]) setRow(was, null);
      } else {
        if (f.pair && !s.spec.wing) {
          wing = `${s.spec.name}-wing@${machineOf(c)}`;
          sessions[wing] = { callsign: wing, state: "idle", spec: { ...s.spec, name: `${s.spec.name}-wing`, wing: undefined, parent: c }, by: c, lead: c, since: now(), last: now(), account: s.account, context: 0.02 };
          delta({ sessions: [{ callsign: wing, row: sessions[wing] }] });
          patch.wing = wing;
        }
        setRow(c, { spec: { ...s.spec, ...patch } });
      }
      // посреди хода модель, усилие, аккаунт, кусочки и папка вступают в силу с новым процессом — после хода
      const keys = Object.keys(f.patch ?? {});
      const slow = s.state === "busy" ? keys.filter((k) => ["model", "effort", "slot", "pieces", "cwd", "fast", "thinking", "style", "remote"].includes(k)) : [];
      return { now: keys.filter((k) => !slow.includes(k)), later: slow, ...(wing ? { wing } : {}) };
    },
    "session.stop": (f) => (setRow(sess(f).c, { state: "stopped", doing: undefined, ask: null }), {}),
    "session.start": (f) => (setRow(String(f.to), { state: "idle", error: undefined }), {}),
    "session.remove": (f) => {
      const c = String(f.to);
      if (f.after_turn && sessions[c]?.state === "busy") return removeAfter.add(c), { after_turn: true };
      return setRow(c, null), {};
    },
    "session.rewind": (f) => {
      const { c, s } = sess(f);
      const all = talk(c);
      const at = f.upto ? all.findIndex((e) => e.uuid === f.upto) : 0;
      if (at < 0) throw new Refusal("not_found", `${c}: сообщения ${f.upto} в разговоре нет`);
      const gone = all[at] as any;
      const text = f.upto && typeof gone?.message?.content === "string" && !gone.message.content.startsWith("<") ? gone.message.content : undefined;
      const changed = ["src/components/Header.tsx", "src/components/MenuButton.tsx", "src/styles/header.css"];
      const files = f.files ? { files: changed, plus: 41, minus: 17 } : {};
      const out = { cut: all.length - at, ...(text ? { text } : {}), ...files };
      if (f.dry) return out;
      live.delete(c);
      all.splice(at);
      recent.set(c, []);
      const said = !f.upto ? "Разговор очищен" : `Откат к ${text ? `«${text.slice(0, 60)}»` : "полученной задаче"}${f.files ? ` · файлы возвращены: ${changed.length}` : ""}`;
      // след отката остаётся в разговоре: его кладёт Host, перечитанная лента его тоже покажет
      const mark = { type: "conversation_reset", uuid: uid("r"), text: said } as Ev;
      all.push(mark);
      emit(c, [mark], true);
      setRow(c, { state: "idle", doing: undefined, ask: null, context: all.length ? 0.2 : 0.02, last: now() });
      tellLead(c, f.upto ? `Ведомый ${c} откачен${text ? ` к сообщению «${text.slice(0, 60)}»` : " к полученной задаче"}: ушло записей — ${out.cut}${f.files ? ", файлы возвращены" : ""}.` : `Ведомый ${c} очищен: разговор начат заново.`);
      void s;
      return out;
    },
    "machine.conversations": (f) => {
      mach(f);
      const here = Object.values(sessions).find((x) => x.spec.cwd === f.cwd && machineOf(x.callsign) === String(f.to).slice(1));
      const rows = [["7e6eb2c6-73ab-4290-8286-f98d91d104f5", "Почини мобильное меню: на узких экранах кнопка уезжает за край", 12 * MIN, 412_000], ["53502722-b9da-4943-82c2-201f9e95efa2", "Обнови зависимости и прогони тесты", 3 * HOUR, 199_797], ["d17a4f49-0c1e-4c7b-9a51-2f6f3f0e9b11", "Разберись, почему падает сборка на CI", DAY, 1_240_000], ["1c681a70-b6a7-4fb2-b783-9de0a319be5a", "Напиши раздел README про выкладку", 3 * DAY, 88_300], ["90e911a9-81a8-4d2c-8c49-d92507b11402", "Сравни два варианта кэша и предложи один", 9 * DAY, 640_500]] as const;
      return { conversations: rows.map(([id, title, ago, size], i) => ({ id, title, at: now() - ago, size, ...(i === 0 && here ? { live: here.callsign } : {}) })) };
    },
    "session.call": (f) => {
      const { c } = sess(f);
      const args: any[] = f.args === undefined ? [] : Array.isArray(f.args) ? f.args : [f.args];
      if (f.method === "interrupt") {
        live.delete(c);
        emit(c, [say("[Request interrupted by user]", now())]);
        setRow(c, { state: "idle", doing: undefined });
        return {};
      }
      if (f.method === "contextUsage") {
        const max = 200_000, total = Math.round((sessions[c].context ?? 0.3) * max);
        const cat = (name: string, share: number, kind = "used") => ({ name, tokens: Math.round(total * share), color: "#888", kind });
        return { categories: [cat("Messages", 0.55), cat("System tools", 0.2), cat("Memory files", 0.1), cat("MCP tools", 0.08), cat("Skills", 0.05), cat("System prompt", 0.02), { name: "Free space", tokens: max - total, color: "#ccc", kind: "free" }], totalTokens: total, maxTokens: max, rawMaxTokens: max, percentage: (total / max) * 100, gridRows: [], model: sessions[c].spec.model ?? M, memoryFiles: [], mcpTools: [], agents: [] };
      }
      if (f.method === "mcpStatus") {
        const tools = (n: number) => Array.from({ length: n }, (_, i) => ({ name: "tool_" + i }));
        return [{ name: "fleet", status: "connected", tools: tools(24) }, { name: "playwright", status: "connected", tools: tools(21) }, { name: "github", status: "needs-auth" }, { name: "sentry", status: "failed", error: "сервер не ответил за 30 с" }].map((s) => (mcpOff.has(s.name) ? { name: s.name, status: "disabled" } : s));
      }
      if (f.method === "mcpToggle") return void (args[1] ? mcpOff.delete(args[0]) : mcpOff.add(args[0])), {};
      if (f.method === "mcpReconnect" || f.method === "reload" || f.method === "taskStop") return {};
      if (f.method === "mcpAuthenticate") return { authUrl: "https://github.com/login/oauth/authorize?client_id=mock&state=" + args[0] };
      if (f.method === "tasks") return true;
      if (f.method === "taskOutput") return { output: "> dev\n> vite\n\n  VITE v8.3.7  ready in 412 ms\n  ➜  Local:   http://localhost:5173/\n", total_bytes: 96, truncated: false };
      if (f.method === "commands") return [{ name: "compact", description: "Сжать контекст", argumentHint: "" }, { name: "clear", description: "Начать разговор заново", argumentHint: "" }, { name: "review", description: "Ревью текущих правок", argumentHint: "[что смотреть]" }, { name: "deliver", description: "Довести принятое до конца", argumentHint: "" }, { name: "design", description: "Дизайн в персоне архитектора", argumentHint: "" }];
      if (f.method === "models") return [["claude-fable-5-2", "Fable 5.2"], ["claude-opus-5-5", "Opus 5.5"], ["claude-sonnet-5-5", "Sonnet 5.5"], ["claude-haiku-5-5", "Haiku 5.5"]].map(([value, displayName], i) => ({ value, displayName, description: "", supportsEffort: true, supportedEffortLevels: i === 3 ? ["low", "medium", "high"] : ["low", "medium", "high", "xhigh", "max"], supportsFastMode: i < 2, supportsAutoMode: i < 3 }));
      if (f.method === "agents") return [{ name: "Explore", description: "Поиск по коду: только чтение" }, { name: "critic", description: "Критик прототипа по живой странице" }];
      if (f.method === "usage") return { session: { total_cost_usd: 1.84, total_api_duration_ms: 412_000, total_duration_ms: 3_600_000, total_lines_added: 214, total_lines_removed: 61, model_usage: {} }, subscription_type: "max", rate_limits_available: true, rate_limits: { five_hour: { utilization: 46, resets_at: new Date(now() + 2 * HOUR).toISOString() }, seven_day: { utilization: 38, resets_at: new Date(now() + 3 * DAY).toISOString() } } };
      if (f.method === "status") return { sections: [{ rows: [{ label: "Version", value: "2.1.321" }, { label: "Session ID", value: "7c1e0a52-9d3b" }, { label: "Peer address", value: "x" }] }] };
      if (f.method === "hooks") return { hooks: [{ event: "PreToolUse", matcher: "Bash", displayText: "node .claude/hooks/gate.mjs" }, { event: "Stop", matcher: "", displayText: "node .claude/hooks/summary.mjs" }] };
      if (f.method === "permissionRules") return { state: { rules: [{ behavior: "allow", source: "projectSettings", rule: "Bash(npm run *)" }, { behavior: "deny", source: "userSettings", rule: "Read(~/secrets/**)" }, { behavior: "ask", source: "session", rule: "Bash(git push *)" }] } };
      if (f.method === "sideQuestion") return { response: `Коротко: «${String(args[0]).slice(0, 60)}» — да, это уже учтено в текущей правке; подробности будут в итоге хода.` };
      if (f.method === "compact") {
      setRow(c, { compacting: true });
      setTimeout(() => {
        if (!sessions[c]) return;
        setRow(c, { compacting: undefined, context: 0.12 });
        emit(c, [
          { type: "system", subtype: "compact_boundary", uuid: uid("cb"), compact_metadata: { trigger: "manual", pre_tokens: 68_000, post_tokens: 12_000 } } as Ev,
          { type: "user", uuid: uid("cs"), isCompactSummary: true, timestamp: new Date(now()).toISOString(), message: { role: "user", content: "Summary:\nРазобрана причина: стили меню на узких экранах. Правка внесена в Header.tsx и header.css, тесты 6 из 6. Осталось: снять экран на 390 и приложить к итогу." } } as Ev,
        ]);
        tellLead(c, `Ведомый ${c} сжат: контекст 12%.`);
      }, 2500);
      return {};
      }
      return {};
    },
    message: (f) => {
      const { c, s } = sess(f);
      if (s.state === "stopped" || s.state === "failed") throw new Refusal("stopped", `${c}: сессия ${s.state} — запускает session.start`);
      const uuid = uid("m");
      const pics = ((f.files ?? []) as Array<{ name: string; mime: string; base64: string }>).filter((x) => x.mime.startsWith("image/"));
      const content = pics.length ? [{ type: "text", text: String(f.text) }, ...pics.map((p) => ({ type: "image", source: { type: "base64", media_type: p.mime, data: p.base64 } }))] : String(f.text);
      const event = { type: "user", uuid, from: MY_ADDR, timestamp: new Date(now()).toISOString(), message: { role: "user", content } } as Ev;
      if (s.state === "busy" && f.priority !== "now") {
        (queue.get(c) ?? (queue.set(c, []), queue.get(c)!)).push({ uuid, text: String(f.text), from: MY_ADDR, at: now(), event });
        // сообщение в очереди видно зрителям сразу, а в разговор попадает, когда его возьмёт ход
        emit(c, [event, { type: "message.status", uuid, status: "queued" } as Ev], true);
        return { queued: true, uuid };
      }
      if (s.state === "busy") {
        live.delete(c);
        emit(c, [say("[Request interrupted by user]", now())]);
      }
      emit(c, [event]);
      startLive(c, String(f.text).slice(0, 40));
      setRow(c, { state: "busy", doing: "Читает сообщение", unread: [], error: undefined });
      return { queued: false, uuid };
    },
    "message.cancel": (f) => cancelQueued(sess(f).c, f.uuid),
    "session.history": (f) => {
      const all = talk(String(f.to));
      const end = f.before ? Math.max(0, all.findIndex((e) => e.uuid === f.before)) : all.length;
      const start = Math.max(0, end - (f.limit ?? 50));
      return { events: all.slice(start, end), more: start > 0, seq: seqs.get(String(f.to)) ?? 0 };
    },
    "session.files": (f) => ({ files: ["src/components/Header.tsx", "src/components/Footer.tsx", "src/lib/http.ts", "src/routes.ts", "package.json", "README.md"].filter((p) => p.toLowerCase().includes(String(f.q).toLowerCase())) }),
    "session.watch": (f) => {
      const c = String(f.to);
      watched.add(c);
      const seq = seqs.get(c) ?? 0, kept = recent.get(c) ?? [];
      const waiting = (queue.get(c) ?? []).map(({ event: _event, ...q }) => q);
      const base = { seq, ...(waiting.length ? { queued: waiting } : {}) };
      if (f.after === undefined || f.after >= seq) return base;
      // мок помнит последние 200 событий ленты: чего в памяти уже нет — разговор перечитывается
      const first = seq - kept.length;
      return f.after < first ? { ...base, gap: true } : { ...base, events: kept.slice(f.after - first) };
    },
    "session.unwatch": (f) => (watched.delete(String(f.to)), {}),
    "session.read": (f) => (sessions[String(f.to)]?.unread?.includes(ME) && setRow(String(f.to), { unread: (sessions[String(f.to)].unread ?? []).filter((p) => p !== ME) }), {}),
    answer: (f) => {
      const { c, s } = sess(f);
      if (!s.ask || s.ask.id !== f.ask) throw new Refusal("already_answered", "на этот вопрос уже ответили");
      const a = f.answer as any;
      // итог вопроса — событием ленты: кто ответил и чем
      emit(c, [{ type: "ask.answered", uuid: uid("aa"), ask: s.ask.id, kind: s.ask.kind, q: s.ask, by: typeof f.from === "string" ? f.from : MY_ADDR, answer: a, ...(f.via === "push" ? { via: "push" } : {}), at: now() }]);
      if (a === "deny" || a?.action === "deny" || a?.action === "decline" || a?.action === "cancel") setRow(c, { state: "idle", ask: null, unread: [] });
      else {
        startLive(c, s.title ?? "задача");
        setRow(c, { state: "busy", ask: null, doing: "Продолжает после ответа", unread: [] });
      }
      return {};
    },

    "account.list": (f) => {
      const list = accounts[mach(f)] ?? [];
      for (const q of slots[mach(f)] ?? []) place(q, list);
      return { accounts: list, slots: slots[mach(f)] ?? [] };
    },
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
      if (a) Object.assign(a, { ok: true, why: undefined, limits: lim(0.05, 0.02) });
      else list.push((a = { id: "new@example.com", kind: "claude", email: "new@example.com", plan: "Max 5x", limits: lim(0, 0), ok: true, sessions: 0 }));
      // первый вход на машине без очередей заводит main
      if (!slots[m].length) slots[m].push({ name: "main", order: [a.id], lanes: { fable: { account: a.id }, other: { account: a.id } }, sessions: 0 });
      return { account: a };
    },
    "account.remove": (f) => {
      const m = mach(f);
      const list = accounts[m];
      list.splice(list.findIndex((a) => a.id === f.account), 1);
      for (const q of slots[m]) {
        q.order = q.order.filter((x) => x !== f.account);
        place(q, list);
      }
      slots[m] = slots[m].filter((q) => q.order.length);
      return {};
    },
    "key.check": (f) => (mach(f), { ok: true, word: "glm-abliterated ответила за 1,4 с" }),
    "profile.file": () => ({ text: "---\nname: deliver\ndescription: Доводит принятое до конца\n---\n\n# Порядок\n\n1. Код с тестами\n2. Выпуск и живой прогон\n3. Второй проход" }),
    "shell.info": (f) => ({ os: machines[mach(f)].os, shells: ["bash", "node"], home: "/home/yuri" }),
    "shell.run": (f) => (mach(f), { run: "r" + newId().slice(0, 5), state: "done", code: 0, out: "ok", started: now() - 800, ended: now() }),
    "machine.dirs": (f) => {
      mach(f);
      const path = f.path ?? "~/projects";
      return { path, dirs: path === "~/projects" ? ["site", "billing", "docs", "infra", "prices", "sandbox"] : ["src", "test", "scripts", "docs"], recent: ["~/projects/site", "~/projects/billing", "~/projects/docs", "~/projects/infra"], git: path !== "~/projects" };
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
      const target = (f.machine ? f.build : builds.stable) ?? builds.stable;
      Object.values(machines).filter((m) => m.online && (f.machine ? m.name === f.machine : !(m.name in builds.pins))).forEach((m, i) => setTimeout(() => {
        machines[m.name] = { ...machines[m.name], build: target ?? m.build };
        delta({ machines: [machines[m.name]] });
      }, 1500 * (i + 1)));
      return {};
    },
    "ledger.add": () => ({}),
    "reach.devices": () => ({ devices }),
    "reach.remove": (f) => (devices.splice(devices.findIndex((d) => d.id === f.device), 1), {}),
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
    "github.app": () => ({ installed: true, name: "switchboard-fleet", url: "https://github.com/apps/switchboard-fleet", repos: ["example/sb-base", "example/sb-web", "example/sb-ops"] }),
    "analytics.state": () => (analyticsDown ? { on: true, ok: false, error: "ClickHouse не ответил за 10 с", machines: [] } : { on: true, ok: true, ms: 180, machines: [{ machine: "server", rows: 18_420, last: now() - 4 * 60_000, pending: 0 }, { machine: "laptop", rows: 9_310, last: now() - 3 * HOUR, pending: 2 }, { machine: "anya-pc", rows: 0, pending: 0 }] }),
    "analytics.fill": () => ({ queued: 2 }),
    "analytics.query": (f) => {
      if (analyticsDown) throw new Refusal("analytics_unavailable", "ClickHouse не ответил за 10 с");
      const days = Math.max(1, Math.round((Date.parse(f.until) - Date.parse(f.since)) / DAY) + 1);
      const mk = (key: string, w: number, i: number) => ({ key, calls: Math.round(w * (120 + i * 17)), input: Math.round(w * 2.1e6), output: Math.round(w * 4.2e5), cacheRead: Math.round(w * 2.6e7), cacheWrite: Math.round(w * 3.1e6), cost: Math.round(w * 38.4 * 100) / 100 });
      const KEYS: Record<string, Array<[string, number]>> = {
        model: [["claude-fable-5-2", 4.2], ["claude-sonnet-5-5", 1.6], ["claude-opus-5-5", 0.9], ["glm-abliterated", 0.3]],
        machine: [["server", 3.1], ["laptop", 2.7], ["anya-pc", 1.0], ["base2", 0.2]],
        session: [["ingest@server", 1.4], ["site@laptop", 1.2], ["lead@laptop", 0.9], ["nightcheck@server", 0.8], ["landing@anya-pc", 0.7], ["deploy@server", 0.5], ["docs@laptop", 0.4]],
        person: [["~yuri@example.com", 5.6], ["~anya@example.com", 1.2], ["~oleg@example.com", 0.2]],
        project: [["infra", 3.0], ["site", 2.8], ["research", 1.2]],
      };
      if (f.by === "day") {
        return { rows: Array.from({ length: days }, (_, i) => {
          const r = mk(new Date(Date.parse(f.since) + i * DAY).toISOString().slice(0, 10), 0.5 + ((i * 37) % 11) / 9, i);
          const cut = f.split ? KEYS[f.split as string] : undefined;
          if (!cut) return r;
          const sum = cut.reduce((a, [, w]) => a + w, 0);
          // доли слоёв немного гуляют по дням
          const raw = cut.map(([k, w], j) => [k, w * (0.7 + ((i * 5 + j * 3) % 7) / 10)] as const), rawSum = raw.reduce((a, [, w]) => a + w, 0);
          return { ...r, parts: Object.fromEntries(raw.map(([k, w]) => [k, Math.round((r.cost * w * sum) / (rawSum * sum) * 100) / 100])) };
        }) };
      }
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
  };

  // запросы экранов (пропуска, аккаунты, профили, архив, правила, наблюдение) — в screens.ts: ложатся поверх прежних
  const screenCtx = { now, T, ME, MY_ADDR, machines, sessions, people, projects, passes, devices, keys, accounts, slots, pieces, archive, incidents, prefs, ledger, obs, archPoints, journal, talk, talks, need, mach, sess, delta, setRow, row };
  Object.assign(H, screenHandlers(screenCtx));
  // запросы второй итерации экранов — поверх: iter2.ts
  Object.assign(H, iter2Handlers(screenCtx, { ...H }));
  // наблюдение первого класса и находки архива в формах службы — поверх: iter4.ts
  Object.assign(H, iter4Handlers(screenCtx, { ...H }));

  const SPANS: Record<string, string[]> ={ session: ["services", "platform", "host"], machine: ["services", "platform", "host"], fleet: ["services", "platform"] };
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
      r = ok(f.id!, structuredClone(h(f)));
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
