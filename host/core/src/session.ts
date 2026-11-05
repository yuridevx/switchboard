// Сессия: один query() Agent SDK, очередь ввода, процесс у своего держателя. Состояние — только из SDK (session_state_changed).
// Неожиданный выход процесса — один resume; второй сбой до готовности — failed, причина в журнале.
// Ядра сессия не знает: всё нужное ей — SessionDeps.
import type { Options, PermissionResult, ElicitationResult, Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { LogRecord, Session, SessionState, StartKind, Store } from "../contract.ts";
import type { Decisions } from "./decisions.ts";
import { SESSION_FUNCTIONS } from "./calls.ts";
import type { Clock } from "./clock.ts";
import { wholeConversation } from "./history.ts";
import type { Exited, HeldProcess, HolderClient } from "./holders.ts";
import { collectParts, mergeParts } from "./parts.ts";
import type { Parts } from "./parts.ts";
import { tildePath } from "./paths.ts";
import { InputQueue } from "./queue.ts";
import { refuse } from "./refusal.ts";
import type { CoreRecord, Stores } from "./store.ts";
import { handled, MODULE_ERROR, START_MS } from "./trap.ts";
import type { Mod, Scope, Trap } from "./trap.ts";

/** Предел ответа процесса claude на initialize — тот же, что у startup() SDK (initializeTimeoutMs по умолчанию 60 с). */
export const INIT_MS = 60_000;
/** Предел одной ступени остановки процесса claude: итог хода после прерывания, выход после закрытия ввода. Две ступени вместе — меньше предела запроса клиента. */
export const STOP_MS = 30_000;
/** Сколько restart ждёт конца хода: ход может законно идти часами. Вышло — перезапуск отменён, ход не трогаем (слово пользователя 4 нояб.). */
export const RESTART_WAIT_MS = 6 * 3_600_000;

const SDK_STATE: Record<string, SessionState> = { idle: "idle", running: "busy", requires_action: "waiting" };
const LIVE = new Set<SessionState>(["idle", "busy", "waiting"]);

/** То, что ядро берёт от Agent SDK. На стенде — подделка. */
export type SdkApi = {
  query: (p: { prompt: AsyncIterable<SDKUserMessage>; options?: Options }) => Query;
  /** функции SDK сессии: getSessionMessages, renameSession… */
  functions: Record<string, (...a: any[]) => Promise<unknown>>;
  /** команда claude той же версии */
  cli: (args: string[], env: Record<string, string | undefined>, input?: string) => Promise<{ code: number | null; out: string }>;
  /** путь к исполняемому claude из пакета SDK: его же получает query() сессии — SDK не ищет его второй раз */
  bin?: string;
};

/** Что сессии нужно от ядра. */
export type SessionDeps = {
  trap: Trap;
  decisions: Decisions;
  holders: HolderClient;
  sdk: SdkApi;
  stores: Stores;
  clock: Clock;
  sdkVersion: string;
  log(rec: LogRecord): void;
  /** записать список сессий на диск */
  saveCore(): void;
  /** кадр в relay: ok — ушёл */
  send(f: { type: string; [k: string]: unknown }): { ok: boolean };
  /** сессия ещё в списке ядра */
  listed(callsign: string): boolean;
  /** убрать из списка ядра */
  unlist(callsign: string): void;
  /** s.field: поле у владельца; имя из своих provides или uses */
  fieldOwner(m: Mod, scope: Scope, name: string): Mod | undefined;
};

/** Первый запуск: новый разговор, разговор с диска или его копия. */
type First = { fresh?: boolean; resume?: string; fork?: boolean };

export class Sess implements Scope {
  readonly rec: CoreRecord;
  state: SessionState = "starting";
  q: Query | null = null;
  proc: HeldProcess | null = null;
  startKind: StartKind = "spawn";
  point: number | undefined;
  model: string | null = null;
  /** модули, выключенные в этой сессии: имя → причина */
  readonly failed = new Map<string, string>();
  private readonly deps: SessionDeps;
  private readonly queue = new InputQueue();
  /** initialize этого query() прошёл */
  private ready = false;
  /** сбоев подряд до готовности */
  private crashes = 0;
  /** процесс закрывают намеренно: его выход не сбой */
  private closing: null | "stop" | "restart" | "shutdown" = null;
  /** причины сбоев до готовности: идут в строку failed */
  private reasons: string[] = [];
  private resultWaiters: Array<() => void> = [];
  private exitWaiters: Array<() => void> = [];
  private settleWaiters: Array<() => void> = [];
  private lastSent = "";
  private readonly views = new Map<Mod, Session>();

  constructor(deps: SessionDeps, rec: CoreRecord) {
    this.deps = deps;
    this.rec = rec;
  }

  get callsign(): string {
    return this.rec.callsign;
  }

  // ───────────── запуск ─────────────

  /** Вид старта до сборки вкладов: session() модуля уже видит s.info.start и point. */
  prepare(kind: StartKind, point?: number): void {
    this.startKind = kind;
    if (kind === "point") this.point = point;
  }

  /** Запрос открытия — модулям с opening, один проход до session(). Отказ словом идёт наружу; модуль выключен или упал — module_error, а не тихий запуск без его выбора. */
  async collectOpening(req: Record<string, unknown>): Promise<void> {
    const { trap } = this.deps;
    for (const m of trap.mods) {
      if (!m.module.opening) continue;
      const reads = m.module.openingReads;
      if (trap.isDown(m, this) && reads && !reads.some((k) => req[k] !== undefined)) continue;
      const read = await trap.call(m, "opening", this, async (x) => (await trap.within(x.opening!(this.facade(m), req), `opening() не вернулся за ${START_MS / 1000} с`), true), () => false);
      if (!read) throw refuse(MODULE_ERROR, `${m.name} выключен: запрос открытия ${this.callsign} не прочитан`);
    }
  }

  collectParts(): Promise<Parts> {
    return collectParts(this.deps.trap, this, (m) => this.facade(m));
  }

  private options(parts: Parts, attach: boolean, first?: First): Options {
    const { trap, decisions, holders, sdk } = this.deps;
    const merged = mergeParts(trap, this, parts);
    let attachOnce = attach;
    const start: Record<string, unknown> = {};
    if (first?.fresh) start.sessionId = this.rec.session_id;
    else if (first?.resume && first.fork) Object.assign(start, { resume: first.resume, forkSession: true, sessionId: this.rec.session_id });
    else start.resume = this.rec.session_id;
    return {
      // режим устава; сессию в другом режиме поднимает её владелец — manage, вкладом
      permissionMode: "bypassPermissions",
      ...merged,
      ...start,
      cwd: this.rec.cwd,
      ...(sdk.bin ? { pathToClaudeCodeExecutable: sdk.bin } : {}),
      allowDangerouslySkipPermissions: true,
      // состояние сессии — только из session_state_changed; SDK шлёт его лишь с этим ключом
      env: { ...process.env, ...merged.env, DISABLE_UPDATES: "1", CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1" },
      canUseTool: (tool, input, o): Promise<PermissionResult> => decisions.canUseTool(this, tool, input, o as Record<string, unknown>),
      onElicitation: (req, o): Promise<ElicitationResult> => decisions.elicit(this, req, o),
      spawnClaudeCodeProcess: (o) => {
        const p = holders.channel(attachOnce ? "attach" : "spawn", this.callsign, o);
        attachOnce = false;
        this.proc = p;
        return p;
      },
    } as Options;
  }

  /**
   * Поднять процесс сессии: spawn нового, resume разговора, attach к живому у держателя.
   * Ответ — после initialize; процесс умер до него — исключение (ветку сбоя ведёт выход от держателя).
   */
  async launch(kind: StartKind, o: { parts?: Parts; first?: First } = {}): Promise<void> {
    const { sdk, clock, log, saveCore, sdkVersion } = this.deps;
    this.prepare(kind, kind === "point" ? this.point : undefined);
    this.ready = false;
    this.setState("starting");
    this.push();
    const attach = kind === "attach";
    if (!attach) {
      this.rec.sdk = sdkVersion;
      saveCore();
    }
    let parts: Parts;
    let first = o.first;
    try {
      parts = o.parts ?? (await this.collectParts());
      // файл разговора claude пишет на первом ходе: до него resume поднимать нечего — запуск с тем же id заново
      if (kind === "resume" && !first && !(await sdk.functions.getSessionInfo(this.rec.session_id, { dir: this.rec.cwd })))
        first = this.rec.fork ? { resume: this.rec.fork, fork: true } : { fresh: true };
    } catch (e) {
      this.reasons.push((e as Error).message);
      this.fail();
      throw e;
    }
    const q = sdk.query({ prompt: this.queue.stream(), options: this.options(parts, attach, first) });
    this.q = q;
    log({ ev: "launch", callsign: this.callsign, start: first?.fresh ? "spawn" : first?.fork ? "fork" : kind, sdk: this.rec.sdk, session_id: this.rec.session_id });
    void this.pump(q);
    // процесс жив, но молчит на initialize: убить — дальше ветка «процесс умер»: один resume, второй сбой — failed
    const late = clock.setTimeout(() => {
      log({ kind: "stop", ev: "initialize_late", callsign: this.callsign, why: `процесс не ответил на initialize за ${INIT_MS / 1000} с — kill` });
      // своим соединением: holders.kill — для ничьих, второе соединение дало бы второй выход
      this.proc?.kill("SIGKILL");
    }, INIT_MS);
    try {
      await q.initializationResult();
    } catch (e) {
      throw new Error(`${this.callsign}: процесс вышел до initialize — ${(e as Error).message}`);
    } finally {
      clock.clearTimeout(late);
    }
    if (this.q !== q) throw new Error(`${this.callsign}: процесс сменился до initialize`);
    this.ready = true;
    this.crashes = 0;
    this.reasons = [];
    if (this.state === "starting") this.setState(attach && this.rec.state && LIVE.has(this.rec.state) ? this.rec.state : "idle");
    this.notify("open", (x, m) => x.on?.open?.(this.facade(m)));
    // процесс запущен прежним SDK: ход доходит до конца, затем resume с claude новой версии
    if (attach && this.rec.sdk !== sdkVersion) void this.restart().catch(() => {});
  }

  /** Всем модулям с on.<имя>: ошибка одного не мешает остальным. */
  private notify(name: "open" | "close" | "state" | "event", fn: (x: Mod["module"], m: Mod) => void): void {
    const { trap } = this.deps;
    for (const m of trap.mods) if (m.module.on?.[name]) trap.call(m, `on.${name}`, this, (x) => fn(x, m), () => undefined);
  }

  private async pump(q: Query): Promise<void> {
    try {
      for await (const m of q) this.onMessage(m);
    } catch {
      // конец потока: причину даст выход от держателя
    }
  }

  private onMessage(m: SDKMessage): void {
    if (m.type === "system" && m.subtype === "init") {
      if (m.session_id && m.session_id !== this.rec.session_id) {
        this.rec.session_id = m.session_id;
        this.deps.saveCore();
      }
      this.model = (m as { model?: string }).model ?? null;
    }
    if (m.type === "system" && m.subtype === "session_state_changed") {
      const st = SDK_STATE[(m as { state: string }).state];
      // сессию закрывают: что процесс говорит о ходе, больше не важно
      if (st && !this.closing && (LIVE.has(this.state) || this.state === "starting")) this.setState(st);
    }
    this.notify("event", (x, mod) => x.on?.event?.(this.facade(mod), m));
    if (m.type === "result") for (const w of this.resultWaiters.splice(0)) w();
    this.push();
  }

  /** Выход процесса от держателя: наш close — ожидаемо; иначе сбой — один resume, второй до готовности — failed. */
  onExited(e: Exited): void {
    const why = `код ${e.code}${e.signal ? `, сигнал ${e.signal}` : ""}${e.stderr ? `: ${e.stderr}` : ""}`;
    for (const w of this.exitWaiters.splice(0)) w();
    // процесс вышел посреди хода: итога не будет — ждущие его не висят
    for (const w of this.resultWaiters.splice(0)) w();
    // вышел, пока закрывали: закрывающему ждать больше нечего
    if (this.closing) {
      this.q = null;
      this.proc = null;
      return;
    }
    if (!this.q) return;
    this.q = null;
    this.proc = null;
    // ОС останавливается раньше, чем об этом узнаёт Host (win11-2 1 нояб.: держатель на 5 с раньше службы): не падение,
    // resume посреди выключения не нужен; в записи сессия не остановлена — новый Host поднимет её сам
    if (e.os_stop) {
      this.deps.log({ ev: "session_os_stop", callsign: this.callsign, why: `остановка ОС: процесс claude вышел, ${why}` });
      this.setState("stopped");
      this.notifyClose();
      return;
    }
    this.reasons.push(why);
    this.deps.log({ kind: "stop", ev: "session_exited", callsign: this.callsign, why: `процесс claude вышел, ${why}` });
    this.notifyClose();
    this.crashes = this.ready ? 1 : this.crashes + 1;
    if (this.crashes >= 2) return this.fail();
    void this.launch("resume").catch(() => {});
  }

  private fail(): void {
    this.q = null;
    this.setState("failed");
    this.deps.log({ kind: "stop", ev: "session_failed", callsign: this.callsign, why: `второй сбой до готовности — сессия стоит до session.start: ${this.reasons.join(" · ")}` });
  }

  /** Ждать, пока сессия поднимется или встанет. */
  settled(): Promise<void> {
    if (this.state !== "starting") return Promise.resolve();
    return new Promise((r) => this.settleWaiters.push(r));
  }

  setState(st: SessionState): void {
    if (this.state === st) return;
    this.state = st;
    if (LIVE.has(st)) {
      this.rec.state = st;
      this.deps.saveCore();
    }
    if (st !== "starting") for (const w of this.settleWaiters.splice(0)) w();
    this.notify("state", (x, m) => x.on?.state?.(this.facade(m), st));
    this.push();
  }

  private notifyClose(): void {
    this.notify("close", (x, m) => x.on?.close?.(this.facade(m)));
  }

  // ───────────── управление ─────────────

  private nextResult(): Promise<void> {
    return new Promise((r) => this.resultWaiters.push(r));
  }

  private async closeQuery(): Promise<void> {
    const q = this.q;
    if (!q) return;
    const exited = new Promise<void>((r) => this.exitWaiters.push(r));
    this.q = null;
    q.close();
    await this.orKill(exited, "выхода процесса после закрытия ввода");
    this.proc = null;
  }

  /** Ступень остановки с пределом: не дождались — процесс убит, ждущих отпускает его выход; не вышел и за предел после kill — отказ словом. */
  private orKill(wait: Promise<void>, what: string): Promise<void> {
    const { clock, log } = this.deps;
    return new Promise((done, refused) => {
      let timer = clock.setTimeout(() => {
        log({ kind: "stop", ev: "stop_late", callsign: this.callsign, why: `нет ${what} за ${STOP_MS / 1000} с — kill` });
        this.proc?.kill("SIGKILL");
        timer = clock.setTimeout(() => refused(new Error(`${this.callsign}: процесс не вышел и через ${STOP_MS / 1000} с после kill`)), STOP_MS);
      }, STOP_MS);
      void wait.then(() => {
        clock.clearTimeout(timer);
        done();
      });
    });
  }

  /** Конец хода, но не дольше предела restart: false — ход ещё идёт. */
  private turnEnded(): Promise<boolean> {
    const { clock } = this.deps;
    return new Promise((done) => {
      const late = clock.setTimeout(() => done(false), RESTART_WAIT_MS);
      void this.nextResult().then(() => {
        clock.clearTimeout(late);
        done(true);
      });
    });
  }

  private async interruptTurn(): Promise<void> {
    if (!this.q || (this.state !== "busy" && this.state !== "waiting")) return;
    const r = this.nextResult();
    // ответа на прерывание не ждём: важен итог хода, а молчащий процесс не ответит
    void this.q.interrupt().catch(() => {});
    await this.orKill(r, "итога хода после прерывания");
  }

  async stop(): Promise<void> {
    const { saveCore, log } = this.deps;
    if (!this.q) {
      this.setState("stopped");
      this.rec.stopped = true;
      saveCore();
      return;
    }
    this.closing = "stop";
    try {
      await this.interruptTurn();
      this.setState("stopping");
      await this.closeQuery();
      this.rec.stopped = true;
      this.setState("stopped");
      saveCore();
      this.notifyClose();
      log({ ev: "stop", callsign: this.callsign });
    } finally {
      this.closing = null;
    }
  }

  async restart(): Promise<void> {
    if (!this.q) return this.start();
    if ((this.state === "busy" || this.state === "waiting") && !(await this.turnEnded())) {
      this.deps.log({ kind: "refuse", ev: "restart_late", callsign: this.callsign, why: `ход не кончился за ${RESTART_WAIT_MS / 3_600_000} ч — перезапуск отменён` });
      return;
    }
    // пока ждали конца хода, сессию начали закрывать: stop важнее перезапуска
    if (this.closing) return;
    this.closing = "restart";
    try {
      await this.closeQuery();
      this.notifyClose();
    } finally {
      this.closing = null;
    }
    this.deps.log({ ev: "restart", callsign: this.callsign });
    await this.launch("resume");
  }

  async start(o: { point?: number } = {}): Promise<void> {
    if (this.q) return;
    this.rec.stopped = false;
    this.crashes = 0;
    this.reasons = [];
    this.point = o.point;
    this.deps.saveCore();
    await this.launch(o.point !== undefined ? "point" : "resume");
  }

  async remove(): Promise<void> {
    const { unlist, saveCore, stores, send, log } = this.deps;
    await this.stop();
    unlist(this.callsign);
    saveCore();
    stores.removeSession(this.callsign);
    send({ type: "session.state", callsign: this.callsign, state: null });
    log({ ev: "remove", callsign: this.callsign });
  }

  /** Штатная остановка Host: процесс остаётся у своего держателя, новый Host подключится к нему. */
  shutdown(): void {
    if (this.q) this.closing = "shutdown";
  }

  // ───────────── roster ─────────────

  /** Запись сессии в roster: поля ядра и поля модулей; выключенные модули — в failed. */
  record(): Record<string, unknown> {
    const { trap } = this.deps;
    // папка и отправитель последнего ввода — у ядра: по ним клиент выводит проект сессии и «моё»;
    // поле — by: from в кадре — адрес отправителя самого кадра
    const r: Record<string, unknown> = { callsign: this.callsign, state: this.state, sdk: this.rec.sdk, dir: tildePath(this.rec.cwd) };
    if (this.rec.from) r.by = this.rec.from;
    for (const m of trap.mods) {
      for (const name of Object.keys(m.module.fields ?? {})) {
        const v = this.fieldOf(m, name);
        if (v !== undefined) r[name] = v;
      }
    }
    const failed: Record<string, string> = {};
    for (const m of trap.mods) if (m.down) failed[m.name] = m.down;
    for (const [n, why] of this.failed) failed[n] = why;
    if (Object.keys(failed).length) r.failed = failed;
    return r;
  }

  /** Поле модуля m в записи сессии: модуль выключен или поле не вышло — undefined. */
  private fieldOf(m: Mod, name: string): unknown {
    const { trap } = this.deps;
    if (trap.isDown(m, this)) return undefined;
    const v = trap.call(m, `fields.${name}`, this, (x) => x.fields![name](this.facade(m)), () => undefined);
    return typeof (v as Promise<unknown>)?.then === "function" ? undefined : v;
  }

  helloRecord(): Record<string, unknown> {
    const r = this.record();
    this.lastSent = JSON.stringify(r);
    return r;
  }

  /** Поля или состояние изменились — session.state в relay. */
  push(): void {
    if (!this.deps.listed(this.callsign)) return;
    const r = this.record();
    const j = JSON.stringify(r);
    if (j === this.lastSent) return;
    // связи нет или hello ещё не принят — кадр не ушёл: запомнить нельзя, иначе смена не дойдёт и после roster
    if (this.deps.send({ type: "session.state", ...r }).ok) this.lastSent = j;
  }

  // ───────────── сессия глазами модуля ─────────────

  /** s.sdk: метод query() или функция SDK сессии — только имя из calls модуля. */
  private async sdkCall(m: Mod, name: string, args: unknown[]): Promise<unknown> {
    const { trap, sdk } = this.deps;
    if (!(m.manifest.calls ?? []).includes(name)) trap.violation(m, this, `${name} нет в calls`);
    // у живой сессии заголовок меняет её query: и в файле разговора, и в claude.ai
    if (name === "renameSession" && this.q) return (this.q as unknown as { renameSession: (t: unknown, id: string) => Promise<unknown> }).renameSession(args[0], this.rec.session_id);
    const at = SESSION_FUNCTIONS[name];
    if (at !== undefined) {
      const a: unknown[] = [this.rec.session_id, ...args];
      a[at] = { dir: this.rec.cwd, ...((a[at] as object) ?? {}) };
      if (name === "getSessionMessages") return wholeConversation(sdk.functions, this.rec.session_id, a[at] as { dir?: string });
      return sdk.functions[name](...a);
    }
    if (!this.q) throw new Error(`${this.callsign}: процесс сессии не запущен`);
    return (this.q as unknown as Record<string, (...x: unknown[]) => Promise<unknown>>)[name](...args);
  }

  facade(m: Mod): Session {
    const known = this.views.get(m);
    if (known) return known;
    const { saveCore, stores, fieldOwner } = this.deps;
    const s = this;
    const view: Session = {
      get info() {
        return {
          callsign: s.callsign,
          session_id: s.rec.session_id,
          cwd: s.rec.cwd,
          model: s.model,
          sdk: s.rec.sdk,
          from: s.rec.from ?? null,
          stopped: s.rec.stopped,
          start: s.startKind,
          ...(s.startKind === "point" && s.point !== undefined ? { point: s.point } : {}),
        };
      },
      get state() {
        return s.state;
      },
      input(content, o = {}) {
        // отправитель последнего ввода — в записи сессии: вопрос после перезапуска Host уходит тому же адресату
        if (o.from !== undefined && o.from !== s.rec.from) {
          s.rec.from = o.from;
          saveCore();
        }
        s.queue.push({
          type: "user",
          message: { role: "user", content },
          parent_tool_use_id: null,
          ...(o.priority ? { priority: o.priority } : {}),
          ...(o.uuid ? { uuid: o.uuid as `${string}-${string}-${string}-${string}-${string}` } : {}),
          ...(o.origin !== undefined ? { origin: o.origin as never } : {}),
        });
      },
      sdk: (name, ...args) => handled(s.sdkCall(m, name, args)),
      // сбой запуска ведёт сама сессия (выход → resume → failed): отказ промиса модуль может не ждать
      restart: () => handled(s.restart()),
      stop: () => handled(s.stop()),
      start: (o) => handled(s.start(o)),
      remove: () => handled(s.remove()),
      store: <T>() => stores.session<T>(m.name, s.callsign) as Store<T>,
      field: (name) => {
        const owner = fieldOwner(m, s, name);
        return owner?.module.fields?.[name] ? s.fieldOf(owner, name) : undefined;
      },
      refresh: () => s.push(),
    };
    this.views.set(m, view);
    return view;
  }
}
