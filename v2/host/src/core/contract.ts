// Договор ядра с модулями Host: что модуль отдаёт ядру и что ядро даёт модулю.
import type { Frame, InputOf, Logger, OutputOf, RequestDef, SessionRow, SessionState, Spec } from "@sb/protocol";

/** Хранилище раздела: значение таким, каким его прочтёт следующий Host. */
export type Store<T> = { get(): T | undefined; set(v: T | undefined): void; update(fn: (v: T | undefined) => T | undefined): T | undefined };

/** Вклад модуля в опции запуска сессии. env, mcpServers, settings и остальные ключи — у ключа один хозяин. */
export type QueryPart = {
  env?: Record<string, string>;
  mcpServers?: Record<string, unknown>;
  settings?: Record<string, unknown>;
  /** добавка к системному промпту */
  append?: string;
  hooks?: Record<string, Array<{ matcher?: string; hooks: Array<(...a: any[]) => Promise<unknown>> }>>;
  [option: string]: unknown;
};

export type InputOpts = { from?: string; priority?: "now" | "next" | "later"; uuid?: string; [k: string]: unknown };

/** Сессия глазами модуля. */
export interface SessionApi {
  readonly callsign: string;
  readonly spec: Spec;
  readonly state: SessionState;
  /** разговор claude, папка, кто открыл, модель процесса */
  readonly info: { sessionId: string; cwd: string; by: string; since: number; last?: number; model: string | null };
  /** текст или блоки — в очередь ввода */
  input(content: unknown, opts?: InputOpts): void;
  /** метод query() или функция SDK о разговоре */
  sdk(name: string, ...args: unknown[]): Promise<unknown>;
  stop(): Promise<void>;
  start(): Promise<void>;
  restart(): Promise<void>;
  remove(): Promise<void>;
  /** раздел этого модуля у сессии */
  store<T>(): Store<T>;
  /** строка сессии изменилась у модуля — отдать разницу в картину */
  sync(): void;
}

export type Ctx = {
  /** отправитель: устройство человека, сессия или машина */
  from: string;
  trace?: string;
  log: Logger;
  signal: AbortSignal;
};

export type PermissionResult = { behavior: "allow"; updatedInput?: Record<string, unknown>; updatedPermissions?: unknown[] } | { behavior: "deny"; message: string };
export type DecideOpts = { tool: string; toolUseID: string; signal: AbortSignal; title?: string; description?: string; suggestions?: unknown[]; blockedPath?: string; decisionReason?: unknown };

/** Модуль Host. У имени запроса, кадра и ключа документа один хозяин: два — Host не стартует. */
export interface Module {
  name: string;
  /** запросы договора: ввод уже проверен схемой */
  requests?: Record<string, (input: any, ctx: Ctx) => unknown>;
  /** кадры без ответа */
  frames?: Record<string, (f: Frame, ctx: Ctx) => void>;
  /** ключи документа сессии: проверка значения; негодное — throw Refusal своим словом. s — нет при открытии */
  spec?: Record<string, (value: unknown, s: SessionApi | null) => void | Promise<void>>;
  /** ключ документа изменён у живой сессии: применить без перезапуска */
  applied?(s: SessionApi, keys: string[]): void | Promise<void>;
  /** вклад в опции запуска */
  compose?(s: SessionApi): QueryPart | Promise<QueryPart>;
  /** вклад в строку сессии */
  row?(s: SessionApi): Partial<SessionRow>;
  /** решение за человека: разрешение инструмента и AskUserQuestion; хозяин один */
  decide?(s: SessionApi, input: Record<string, unknown>, opts: DecideOpts): PermissionResult | Promise<PermissionResult>;
  /** форма сервера MCP; хозяин один */
  elicit?(s: SessionApi, request: Record<string, unknown>, opts: { signal: AbortSignal; requestId: string }): Promise<unknown>;
  on?: {
    /** сообщение SDK */
    event?(s: SessionApi, m: any): void;
    state?(s: SessionApi, state: SessionState, was: SessionState): void | Promise<void>;
    /** сессии больше нет */
    removed?(callsign: string): void;
  };
  /** что модуль отдаёт другим модулям этого Host */
  api?: unknown;
  start?(host: HostApi): void | Promise<void>;
  stop?(): void | Promise<void>;
}

export type OpenOpts = { by: string; prompt?: string; resume?: string; fork?: boolean; mkdir?: boolean };

/** Host глазами модуля. */
export interface HostApi {
  readonly machine: string;
  readonly fleet: string;
  /** адрес флота */
  readonly base: string;
  readonly dataDir: string;
  readonly build: number;
  readonly sdkVersion: string;
  /** пропуск машины: заголовок сервера MCP и запросы службам */
  readonly key: string;
  readonly log: Logger;
  readonly signal: AbortSignal;
  session(callsign: string): SessionApi | undefined;
  sessions(): SessionApi[];
  open(spec: Spec, opts: OpenOpts): Promise<SessionApi>;
  /** запрос договора: службе и объекту флота — POST, сессии и машине — у себя или через соединение. from — от чьего имени (сессия этой машины) */
  call<D extends RequestDef<any, any>>(def: D, input: InputOf<D>, opts?: { from?: string; trace?: string }): Promise<OutputOf<D>>;
  /** кадр без ответа в соединение */
  emit(f: Frame): void;
  /** раздел модуля на машине */
  store<T>(): Store<T>;
  /** настройка модуля из host.json */
  config<T>(): T;
  /** команда claude */
  cli(args: string[], o?: { env?: Record<string, string>; input?: string }): Promise<{ code: number | null; out: string }>;
  /** query() без разговора: вход и сведения аккаунта */
  probe(o?: { env?: Record<string, string> }): { sdk(name: string, ...args: unknown[]): Promise<unknown>; close(): void };
  /** модуль этого Host по имени: договор между модулями — его publicApi */
  module<T = unknown>(name: string): T | undefined;
}

export type { Frame, SessionRow, SessionState, Spec };
