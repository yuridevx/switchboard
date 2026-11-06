// Договор модуля Host — единственный вход пакета @switchboard/host.
//
// Модуль Host — пакет монорепо (host/modules/<имя>/) с module.json и contract.ts,
// чей default export — объект Module. Ядро ничего не знает о функциях: оно ведёт сессии
// (по одному query() Claude Agent SDK на сессию) с процессами у держателей, держит соединение с relay,
// собирает вклады модулей и следит, чтобы у каждого имени был один владелец.
//
// Что модуль отдаёт ядру — интерфейс Module. Что ядро даёт модулю — Host и Session:
// у каждого модуля свои объекты host и s, ядро знает, кто зовёт.
//
// Чтобы взять отсюда типы в коде модуля, в его module.json нужен
//   "uses": { "host.module@host": 1 }
// (гейт монорепо пускает импорт @switchboard/* только из uses). Тесты и стенд — без этого.
import type { Roster } from "@switchboard/relay";
export type { Roster };
import type { Frame } from "@switchboard/protocol";
import type {
  ElicitationRequest,
  ElicitationResult,
  HookCallbackMatcher,
  HookEvent,
  McpServerConfig,
  PermissionResult,
  PermissionUpdate,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

export type { Frame } from "@switchboard/protocol";
export type {
  ElicitationRequest,
  ElicitationResult,
  HookCallbackMatcher,
  HookEvent,
  McpServerConfig,
  PermissionResult,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

/** Версия договора модуля: имя host.module в provides ядра. */
export const MODULE_CONTRACT = 1;

/** Файл в кадре: имя, тип, данные base64 — вложение человека сессии и файл, который вернул скрипт. Одна форма для модулей. */
export type Attachment = { name: string; media_type: string; data: string };

// ───────────────────────── манифест ─────────────────────────

/**
 * module.json модуля Host.
 * provides — имена, которыми модуль владеет: запросы, кадры (и входящие, и те, что он шлёт), поля roster,
 *   решение по инструменту — decide.<инструмент>, формы MCP — elicit.
 * into — ["host"]: модуль входит в сборку Host.
 * uses — "имя@владелец": версия; владелец — модуль Host, keeper машины (через relay, to .keeper@машина) или Worker-модуль (через relay).
 * calls — методы query() и функции SDK сессии, которые модуль зовёт через s.sdk / p.sdk.
 * config — схема своего раздела host.json (host.config()).
 */
export type Manifest = {
  name: string;
  type: string;
  version: string;
  provides: Record<string, number>;
  uses: Record<string, number>;
  calls?: string[];
  config: Record<string, "secret" | "var" | "binding">;
  into?: string[];
};

// ───────────────────────── что модуль отдаёт ядру ─────────────────────────

/** Состояние сессии в roster. Имя ядра: модулю его не взять. */
export type SessionState = "starting" | "idle" | "busy" | "waiting" | "stopping" | "stopped" | "failed";

/** Каким был старт процесса сессии. point — resume по разговору, положенному из точки. */
export type StartKind = "spawn" | "resume" | "attach" | "point";

/**
 * Вклад модуля в query() одной сессии. У каждого имени — один владелец:
 * сервер MCP, ключ env, ключ settings, опция query(). Хуки и append складываются списком.
 * Вклад закреплён на время query(): зовётся на каждом старте процесса сессии.
 */
export type QueryPart = {
  /** значения данных, а не кода: ключ env или settings здесь не конфликтует ни с кем, выше стоящий выигрывает, отброшенное — в журнале */
  defaults?: QueryDefaults;
  /** серверы MCP: createSdkMcpServer внутри процесса Host */
  mcpServers?: Record<string, McpServerConfig>;
  /** свои ключи окружения процесса claude, например папка входа слота */
  env?: Record<string, string>;
  /** строка в конец системного промпта (preset claude_code) */
  append?: string;
  /** флаги настроек; у ключа один владелец */
  settings?: Record<string, unknown>;
  /** хуки по событию; SDK зовёт их внутри процесса Host через обёртки ядра */
  hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
  model?: string;
  effort?: string;
  /** прочие опции query(): includePartialMessages, enableFileCheckpointing, maxThinkingTokens… */
  [option: string]: unknown;
};

/** Данные вклада: tier — уровень, account (ключ флота) сильнее profile (кусочки); порядок уровней один, лежит в ядре, ключ модуля сильнее обоих. */
export type QueryDefaults = { tier: "account" | "profile"; env?: Record<string, string>; settings?: Record<string, unknown> };

/** Третий аргумент decide — опции canUseTool SDK: toolUseID — id вызова, signal — ход прервали. */
export type DecideOpts = {
  toolUseID: string;
  signal: AbortSignal;
  suggestions?: PermissionUpdate[];
  /** инструмент: ядро ставит его для общего решения decide.* */
  tool?: string;
  [k: string]: unknown;
};

/** Контекст запроса и кадра: свой host, отправитель (ставит relay) и сигнал остановки Host. */
export type Ctx = { host: Host; from?: string; signal: AbortSignal };

/**
 * Объект модуля — default export его contract.ts. Все поля необязательны.
 *
 * Ловушка ошибок: каждый вызов модуля ядро оборачивает. Бросил — модуль выключен в этой
 * сессии (или на всей машине, если вызов без сессии), в roster сессии — failed: { модуль: причина },
 * строка stop в журнале. Самопочинки нет: чинит агент новым выпуском.
 *   requests → reply ok:false module_error;  frames → кадр дальше не идёт;
 *   on.* → остальные модули получают сообщение как обычно;  session() → query() без вкладов модуля;
 *   hooks → {} (как будто хука нет);  decide → deny "module_error";  elicit → decline;
 *   fields → поле не отдаётся;  start() → модуль выключен на машине;  stop() → строка в журнале.
 *   работа, начатая модулем (таймер, цепочка, событие), — модуль выключен там, где её начал.
 * Отказ словом своего контракта (already_answered, unknown_method…) — refuse(слово): это не ошибка модуля.
 */
export interface Module {
  /** Запросы (кадр с id) — ровно имена из provides; ответ — result в reply. */
  requests?: Record<string, (req: Frame, ctx: Ctx) => unknown | Promise<unknown>>;
  /** Кадры без ответа — имена из provides. */
  frames?: Record<string, (frame: Frame, ctx: Ctx) => void | Promise<void>>;
  /** Поля записи сессии в roster — имена из provides. Ядро собирает их после каждого сообщения SDK. */
  fields?: Record<string, (s: Session) => unknown>;
  /**
   * Запрос открытия сессии (OpenSpec.opening): зовётся ядром только в host.open, до session(). Модуль пишет своё в раздел сессии
   * или отказывает refuse: отказ идёт наружу, разделы несостоявшейся сессии стёрты, папки и процесса нет. Модуль с opening выключен — отказ module_error.
   */
  opening?: (s: Session, req: Record<string, unknown>) => void | Promise<void>;
  /** Поля запроса открытия, которые читает opening: модуль выключен, а этих полей в запросе нет — открытие идёт. Без списка — выключенный модуль отказывает всегда. */
  openingReads?: string[];
  /** Вклад в query() сессии; зовётся на каждом старте процесса сессии, s.info.start уже выставлен. Может быть асинхронным. */
  session?: (s: Session) => QueryPart | undefined | Promise<QueryPart | undefined>;
  /** Решение по инструменту из canUseTool; у инструмента один владелец. Владельца нет — AskUserQuestion: deny unknown_request, прочее — allow. */
  decide?: Record<string, (s: Session, input: Record<string, unknown>, opts: DecideOpts) => PermissionResult | Promise<PermissionResult>>;
  /** Формы MCP (onElicitation); один владелец на Host. */
  elicit?: (s: Session, request: ElicitationRequest, opts: { signal: AbortSignal; requestId: string }) => ElicitationResult | Promise<ElicitationResult>;
  on?: {
    /** каждое сообщение SDK сессии — по порядку списка модулей */
    event?(s: Session, msg: SDKMessage): void;
    /** сессия сменила состояние */
    state?(s: Session, state: SessionState): void;
    /** кадр не модуля Host (roster relay…) — модулям, у которых имя в uses */
    frame?(f: Frame): void;
    /** процесс сессии поднят в этом Host: s.info.start — spawn | resume | attach | point */
    open?(s: Session): void;
    /** query() сессии закрыт: stop, remove, сбой процесса, restart */
    close?(s: Session): void;
    /** Host поднял сессии из хранилища и запустил их процессы: с этого шага модуль зовёт запросы к сессиям. Раз за старт Host. */
    ready?(): void;
  };
  /** Поднять своё из хранилища. Порядок старта — порядок списка модулей. */
  start?(host: Host): void | Promise<void>;
  /** Штатная остановка: снять таймеры, дописать хранилище. Порядок — обратный. */
  stop?(): void | Promise<void>;
}

// ───────────────────────── что ядро даёт модулю ─────────────────────────

/**
 * Ответ запроса: как reply, без конверта (type, id, to, from). Отказ несёт и прочие поля reply владельца —
 * например owner у not_owner. disconnected — связь оборвалась, ответа не было.
 */
export type Result = { ok: true; result?: unknown; [field: string]: unknown } | { ok: false; error: string; [field: string]: unknown };

/** Раздел хранилища модуля. Запись сразу: временный файл и rename, файл всегда целый JSON. */
export interface Store<T = unknown> {
  get(): T | undefined;
  set(value: T | undefined): void;
  update(fn: (cur: T | undefined) => T | undefined): T | undefined;
}

export type SessionInfo = {
  callsign: string;
  session_id: string;
  cwd: string;
  /** модель из system/init */
  model: string | null;
  /** версия SDK, которой запущен процесс сессии */
  sdk: string;
  /** отправитель последнего ввода: кому потом задать вопрос; хранится в записи сессии — переживает перезапуск Host */
  from: string | null;
  /** сессию остановили намеренно: в записи стоит «остановлена»; остановка ОС запись не трогает — новый Host поднимет сессию сам */
  stopped: boolean;
  /** каким был старт процесса сессии */
  start: StartKind;
  /** номер точки, если start — point */
  point?: number;
};

export type InputOpts = {
  from?: string;
  priority?: "now" | "next" | "later";
  uuid?: string;
  origin?: unknown;
};

/** Сессия глазами модуля: host.session(callsign) или аргумент вызова. */
export interface Session {
  readonly info: SessionInfo;
  readonly state: SessionState;
  /** Ввод: текст или блоки. Очередь живёт в ядре и переживает resume. */
  input(content: SDKUserMessage["message"]["content"], opts?: InputOpts): void;
  /** Метод query() или функция SDK сессии (getSessionMessages, renameSession…) — имя из своих calls; id сессии и папку подставляет ядро. */
  sdk(name: string, ...args: unknown[]): Promise<unknown>;
  /** Дождаться result идущего хода, close(), query() с resume. Ход не кончился за предел — перезапуск отменён, причина в журнале, ход идёт дальше. */
  restart(): Promise<void>;
  /** interrupt → result → close(); state stopped, запись в списке остаётся. */
  stop(): Promise<void>;
  /** Поднять остановленную или failed сессию по resume; point — старт из точки. */
  start(opts?: { point?: number }): Promise<void>;
  /** stop и убрать из списка; разделы этой сессии у всех модулей стёрты. */
  remove(): Promise<void>;
  /** Свой раздел хранилища для этой сессии. */
  store<T = unknown>(): Store<T>;
  /**
   * Поле этой сессии в roster от модуля-владельца — то же значение, что уйдёт в session.state, без пути через relay.
   * Имя — из своих provides или uses (поле@владелец), иначе ошибка модуля; владелец выключен — undefined.
   */
  field(name: string): unknown;
  /** Пересобрать поля сессии у владельцев и, если запись изменилась, послать session.state — для поля, которое меняется вне событий SDK. */
  refresh(): void;
}

export type OpenSpec = {
  callsign: string;
  cwd: string;
  /** открыть разговор, файл которого уже на машине */
  resume?: string;
  /** с resume: новый session_id от того же разговора */
  fork?: boolean;
  /** старт из точки с этим номером: s.info.start — point */
  point?: number;
  /** создать папку cwd после сборки вкладов: отказ модуля папки не оставляет */
  mkdir?: boolean;
  /** запрос открытия как есть: его читают модули с opening */
  opening?: Record<string, unknown>;
};

export type SessionSummary = { callsign: string; cwd: string; state: SessionState };

/** Короткий claude без сессии: тот же закреплённый claude, свой env. Не в roster, не у держателя. */
export interface Probe {
  sdk(name: string, ...args: unknown[]): Promise<unknown>;
  close(): void;
}

/** Запись журнала машины: строка JSON в ~/.switchboard/journal/host-<дата>.jsonl. t, part, machine, who ставит ядро. */
export type LogRecord = {
  kind?: "stop" | "refuse" | "note";
  ev: string;
  word?: string;
  why?: string;
  callsign?: string;
  [k: string]: unknown;
};

export interface Host {
  readonly machine: string;
  /** папка данных Host (SWITCHBOARD_HOME или ~/.switchboard): разделы модулей на диске — внутри неё */
  readonly dataDir: string;
  /** версия выпуска Host */
  readonly version: string;
  /** версия Agent SDK этого Host */
  readonly sdk: string;
  session(callsign: string): Session | undefined;
  /** сессии машины, включая остановленные */
  sessions(): SessionSummary[];
  /** Новая сессия; ответ — после initialize. */
  open(spec: OpenSpec): Promise<Session>;
  /**
   * Запрос по имени из своего uses или своего provides; payload — поля кадра с v.
   * Владелец — модуль этой машины: вызов в процессе; иначе — relay
   * (другая машина по callsign/machine/to или Worker-модуль: to = имя владельца).
   * Имени нет в uses — ошибка модуля.
   * Отправитель — payload.from (адрес), иначе @машина: владелец видит его в ctx.from, как у запроса через relay.
   * Отказ несёт слово error и причину why, если владелец её назвал. На своей машине предела нет: действие ограничено своим пределом.
   */
  request(name: string, payload: Record<string, unknown>): Promise<Result>;
  /** То же, но запрос только читает состояние: нет ответа за READ_MS — timeout, и на своей машине, и через relay. Поздний ответ отброшен. */
  read(name: string, payload: Record<string, unknown>): Promise<Result>;
  /** Кадр без ответа в relay (type — из своих provides или uses). Обрыв — disconnected; очереди нет; больше предела кадра — too_large. */
  emit(frame: Frame): Result;
  /** Свой раздел машины. */
  store<T = unknown>(): Store<T>;
  /** Свой раздел modules.<имя> в host.json. */
  config<T = unknown>(): T;
  log(record: LogRecord): void;
  probe(opts?: { env?: Record<string, string> }): Probe;
  /** Команда claude той же версии; secrets — только через env. */
  cli(args: string[], opts?: { env?: Record<string, string>; input?: string }): Promise<{ code: number | null; out: string }>;
  /** Последний roster от relay; до первого — null. Один на Host, как у ядра веба. */
  roster(): Roster | null;
}

// ───────────────────────── отказ словом ─────────────────────────

export { Refusal, refuse, isRefusal, REFUSAL } from "./src/refusal.ts";

// ───────────────────────── ввод сессии ─────────────────────────

/**
 * content: текст и вложения → содержимое сообщения user: без вложений — строка, иначе блоки; блока для типа нет — отказ bad_attachment.
 * IMAGE_TYPES: типы файлов, которые модель видит картинкой — блок image во вводе и в ответе инструмента MCP.
 */
export { content, IMAGE_TYPES } from "./src/content.ts";
export { clientPath, claudeDir, tildePath } from "./src/paths.ts";

// ───────────────────────── стенд ─────────────────────────

/** Стенд для тестов модулей: поддельные SDK, relay, держатели и часы. */
export * as stand from "./stand/index.ts";
