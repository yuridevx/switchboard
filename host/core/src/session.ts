// Сессия: один процесс claude у держателя за раз, один query() на процесс. Владеет его жизнью, записью сессии и очередью ввода.
//
//   starting ──initialize──► idle ⇄ busy ⇄ waiting ──stop──► stopping ──► stopped
//      ▲   │                   │
//      │   └── второй сбой до готовности ──► failed          выход с os_stop ──► stopped (в записи не остановлена)
//      └────── процесс умер: один resume ◄─┘
import type { PermissionResult, Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { DecideOpts, Frame, InputOpts, LogRecord, QueryPart, Session, SessionInfo, SessionState, StartKind } from "../contract.ts";
import { QUERY_METHODS, SESSION_FUNCTIONS } from "./calls.ts";
import { limit, type Clock } from "./clock.ts";
import type { Exit, Held, Holders } from "./holders.ts";
import { wholeConversation } from "./history.ts";
import { CORE_OPTIONS, mergeParts, type Merged } from "./parts.ts";
import { tildePath } from "./paths.ts";
import { isRefusal, refuse, type Refusal } from "./refusal.ts";
import type { SdkApi } from "./release.ts";
import type { CoreRecord, Stores } from "./store.ts";
import { handled, type Mod, type Trap } from "./trap.ts";

const STEP_MS = 30_000; // ступень остановки процесса
const INITIALIZE_MS = 60_000; // как initializeTimeoutMs у startup() SDK: у query() своего предела нет
const RESTART_WAIT_MS = 6 * 3_600_000; // ход законно идёт часами (слово пользователя 4 нояб.)

type Phase = "starting" | "running" | "stopping" | "stopped" | "failed";
type Turn = "idle" | "busy" | "waiting";
const TURN_OF: Record<string, Turn> = { idle: "idle", running: "busy", requires_action: "waiting" };

/** То, что сессии нужно от Host. */
export type SessionEnv = {
  sdk: SdkApi;
  sdkVersion: string;
  clock: Clock;
  trap: Trap;
  mods: Mod[];
  owners: Map<string, Mod>;
  stores: Stores;
  holders: Holders;
  log(record: LogRecord): void;
  /** записи всех сессий изменились: на диск */
  saveRecords(): void;
  send(frame: Frame): { ok: boolean };
  /** Host останавливается: процессы остаются у держателей, их выходы — дело следующего Host */
  shutting(): boolean;
  forget(s: Sess): void;
};

/** Очередь ввода: живёт дольше процесса. Читает только последний поток; поток ушедшего процесса отставлен сразу, иначе SDK заберёт сообщение и никуда его не напишет. */
class InputQueue {
  private items: SDKUserMessage[] = [];
  private reader = 0;
  private wake: (() => void) | null = null;

  push(m: SDKUserMessage): void {
    this.items.push(m);
    this.wake?.();
  }

  retire(): void {
    this.reader++;
    this.wake?.();
  }

  async *stream(): AsyncGenerator<SDKUserMessage, void> {
    const me = ++this.reader;
    for (;;) {
      while (this.items.length && this.reader === me) yield this.items.shift()!;
      if (this.reader !== me) return;
      await new Promise<void>((r) => (this.wake = r));
    }
  }
}

export class Sess {
  readonly rec: CoreRecord;
  readonly failed: Record<string, string> = {};
  readonly callsign: string;
  startKind: StartKind;
  point?: number;
  model: string | null = null;
  /** в списке машины: запись идёт в relay */
  listed = false;

  private readonly env: SessionEnv;
  private readonly input = new InputQueue();
  private readonly facades = new Map<Mod, Session>();
  private phase: Phase;
  private turn: Turn = "idle";
  private shown: SessionState;
  private q: Query | null = null;
  private held: Held | null = null;
  /** resolved, когда процесс вышел и вывод дочитан */
  private over: Promise<void> = Promise.resolve();
  /** нет разговора на диске: новый id, а не resume */
  private fresh = false;
  /** stop или restart ведут выход сами: это не сбой */
  private closing = false;
  /** причины сбоев подряд */
  private fails: string[] = [];
  /** вклады, собранные заранее: на старте Host их проверяют до первого подключения к держателям */
  private prepared: Merged | null = null;
  private sent = "";
  private turnWaiters = new Set<() => void>();
  private settleWaiters = new Set<() => void>();

  constructor(env: SessionEnv, rec: CoreRecord, kind: StartKind, point?: number) {
    this.env = env;
    this.rec = rec;
    this.callsign = rec.callsign;
    this.startKind = kind;
    this.point = point;
    this.phase = rec.stopped ? "stopped" : "starting";
    this.shown = this.phase;
    this.fresh = kind === "spawn" || rec.fork !== undefined;
  }

  get state(): SessionState {
    return this.phase === "running" ? this.turn : this.phase;
  }

  get info(): SessionInfo {
    const { callsign, session_id, cwd, sdk, stopped, from } = this.rec;
    return { callsign, session_id, cwd, model: this.model, sdk, from: from ?? null, stopped, start: this.startKind, ...(this.point !== undefined ? { point: this.point } : {}) };
  }

  /** Пока поднимается — ждать; потом — запись в roster. */
  settled(): Promise<void> {
    return this.phase === "starting" ? new Promise((r) => this.settleWaiters.add(r)) : Promise.resolve();
  }

  // ───────────────── запись в roster ─────────────────

  private fieldOf(owner: Mod, name: string): unknown {
    if (owner.isOff(this)) return undefined;
    const v = this.env.trap.call(owner, this, `fields.${name}`, () => owner.module.fields![name](this.facade(owner)), undefined);
    return v instanceof Promise ? undefined : v;
  }

  record(): Frame & { callsign: string } {
    const fields: Record<string, unknown> = {};
    for (const m of this.env.mods) for (const name of Object.keys(m.module.fields ?? {})) fields[name] = this.fieldOf(m, name);
    // выключенные считаются после полей: поле могло упасть только что
    const off = { ...Object.fromEntries(this.env.mods.flatMap((m) => (m.down ? [[m.name, m.down]] : []))), ...this.failed };
    return { callsign: this.callsign, state: this.state, sdk: this.rec.sdk, dir: tildePath(this.rec.cwd), ...(this.rec.from ? { by: this.rec.from } : {}), ...(Object.keys(off).length ? { failed: off } : {}), ...fields } as never;
  }

  /** Запись для hello: relay заменит карточку целиком. */
  hello(): Frame & { callsign: string } {
    const r = this.record();
    this.sent = JSON.stringify(r);
    return r;
  }

  /** Пересобрать запись и, если изменилась, послать в relay. Связи нет — дойдёт при следующей смене или после hello. */
  refresh(): void {
    if (!this.listed) return;
    const r = this.record();
    const text = JSON.stringify(r);
    if (text !== this.sent && this.env.send({ ...r, type: "session.state" }).ok) this.sent = text;
  }

  private changed(): void {
    const now = this.state;
    if (now === this.shown) return;
    this.shown = now;
    if (this.phase === "running") {
      this.rec.state = this.turn;
      this.env.saveRecords();
    }
    this.each("on.state", (m, f) => m.module.on?.state?.(f, now));
    this.refresh();
  }

  private setPhase(phase: Phase): void {
    this.phase = phase;
    this.changed();
    if (phase !== "starting") {
      for (const w of this.settleWaiters) w();
      this.settleWaiters.clear();
    }
  }

  private each(where: string, fn: (m: Mod, s: Session) => void): void {
    for (const m of this.env.mods) if (!m.isOff(this)) this.env.trap.call(m, this, where, () => fn(m, this.facade(m)), undefined);
  }

  // ───────────────── вклады и запуск ─────────────────

  /** Запрос открытия: модули пишут своё в раздел сессии или отказывают. */
  async opening(req: Record<string, unknown>): Promise<void> {
    for (const m of this.env.mods) {
      const read = m.module.opening;
      if (!read) continue;
      const unread = refuse("module_error", `${m.name} выключен: запрос открытия ${this.callsign} не прочитан`);
      if (m.isOff(this)) {
        if (m.module.openingReads && !m.module.openingReads.some((k) => req[k] !== undefined)) continue;
        throw unread;
      }
      let refusal: Refusal | undefined;
      await this.env.trap.limited(m, this, "opening", async () => {
        try {
          await read(this.facade(m), req);
        } catch (e) {
          if (!isRefusal(e)) throw e;
          refusal = e;
        }
      }, undefined);
      if (refusal) throw refusal;
      if (m.isOff(this)) throw unread;
    }
  }

  private partOf(m: Mod): Promise<QueryPart | undefined> {
    if (m.isOff(this) || !m.module.session) return Promise.resolve(undefined);
    return this.env.trap.limited(m, this, "session", async () => {
      let part: QueryPart | undefined;
      try {
        part = await m.module.session!(this.facade(m));
      } catch (e) {
        throw isRefusal(e) ? `отказ ${e.word} в session(): ${e.why ?? ""}` : e;
      }
      const core = Object.keys(part ?? {}).find((k) => CORE_OPTIONS.has(k));
      if (core) throw new Error(`опция ${core} — её держит ядро`);
      return part;
    }, undefined);
  }

  /** Хук в опциях: выключенный модуль — как будто хука нет; бросил — выключен. */
  private guardHooks(m: Mod, part: QueryPart): QueryPart {
    const hooks = Object.fromEntries(
      Object.entries(part.hooks ?? {}).map(([event, matchers]) => [
        event,
        matchers!.map((matcher) => ({
          ...matcher,
          hooks: matcher.hooks.map((h) => (...args: Parameters<typeof h>) => (m.isOff(this) ? Promise.resolve({}) : this.env.trap.wait(m, this, `hooks.${event}`, () => h(...args), {}))),
        })),
      ]),
    );
    return { ...part, hooks };
  }

  /** Собрать вклады модулей; ответ — ключи двух владельцев. */
  async prepare(): Promise<string[]> {
    const parts = await Promise.all(this.env.mods.map((m) => this.partOf(m)));
    this.prepared = mergeParts(this.env.mods.flatMap((m, i) => (parts[i] ? [{ owner: m.name, part: this.guardHooks(m, parts[i]!) }] : [])));
    return this.prepared.conflicts;
  }

  /** Старт процесса по прежнему разговору: файла ещё нет — тот же id заново. */
  async aim(kind: "attach" | "resume" | "point", point?: number): Promise<void> {
    this.startKind = kind;
    this.point = point;
    this.fresh = false;
    if (kind !== "resume") return;
    const info = this.env.sdk.functions.getSessionInfo(this.rec.session_id, { dir: this.rec.cwd });
    this.fresh = !(await limit(this.env.clock, info, STEP_MS, () => ({})));
  }

  private options(merged: Merged, spawned: (h: Held) => void): Record<string, unknown> {
    const { rec, env } = this;
    const talk = !this.fresh ? { resume: rec.session_id } : { ...(rec.fork ? { resume: rec.fork, forkSession: true } : {}), sessionId: rec.session_id };
    return {
      permissionMode: "bypassPermissions",
      ...merged.options,
      env: { ...process.env, ...merged.env, DISABLE_UPDATES: "1", CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1" },
      systemPrompt: { type: "preset", preset: "claude_code", ...(merged.append.length ? { append: merged.append.join("\n\n") } : {}) },
      mcpServers: merged.mcpServers,
      hooks: merged.hooks,
      ...(Object.keys(merged.settings).length ? { settings: merged.settings } : {}),
      ...talk,
      cwd: rec.cwd,
      pathToClaudeCodeExecutable: env.sdk.bin,
      allowDangerouslySkipPermissions: true,
      canUseTool: (tool: string, input: Record<string, unknown>, opts: DecideOpts) => this.decide(tool, input, opts),
      onElicitation: (request: never, opts: { signal: AbortSignal; requestId: string }) => this.elicit(request, opts),
      spawnClaudeCodeProcess: (o: never) => {
        const held = this.startKind === "attach" ? env.holders.attach(this.callsign) : env.holders.spawn(this.callsign, o);
        spawned(held);
        return held;
      },
    };
  }

  /** Поднять процесс. Ответ — после initialize; первый сбой до него — отказ, а что делать дальше, решает ended. */
  launch(): Promise<void> {
    return this.env.trap.outside(() => this.run());
  }

  private async run(): Promise<void> {
    const conflicts = this.prepared ? [] : await this.prepare();
    if (this.phase !== "starting") return;
    const merged = this.prepared!;
    this.prepared = null;
    if (conflicts.length) return this.ended(this.lostWith(conflicts.join("; ")));

    const { rec, env } = this;
    if (this.startKind === "attach") this.turn = rec.state === "busy" || rec.state === "waiting" ? rec.state : "idle";
    else {
      this.turn = "idle";
      rec.sdk = env.sdkVersion;
    }
    env.log({ ev: "launch", callsign: this.callsign, start: this.fresh ? (rec.fork ? "fork" : "spawn") : this.startKind, sdk: rec.sdk, session_id: rec.session_id });

    let spawned!: (h: Held) => void;
    const held = new Promise<Held>((r) => (spawned = r));
    let q: Query;
    try {
      q = env.sdk.query({ prompt: this.input.stream(), options: this.options(merged, (h) => ((this.held = h), spawned(h))) as never });
    } catch (e) {
      this.ended(this.lostWith((e as Error).message));
      throw new Error(`${this.callsign}: процесс вышел до initialize — ${(e as Error).message}`);
    }
    this.q = q;
    this.over = this.pump(q, held);

    const late = env.clock.setTimeout(() => {
      env.log({ kind: "stop", ev: "initialize_late", callsign: this.callsign, why: `процесс не ответил на initialize за ${INITIALIZE_MS / 1000} с — kill` });
      this.held?.terminate();
    }, INITIALIZE_MS);
    try {
      await Promise.race([q.initializationResult(), held.then((h) => h.exit).then(() => Promise.reject(new Error("процесс вышел")))]);
    } catch (e) {
      this.held?.terminate();
      throw new Error(`${this.callsign}: процесс вышел до initialize — ${(e as Error).message}`);
    } finally {
      env.clock.clearTimeout(late);
    }
    if (this.q !== q || this.phase !== "starting") return;

    this.fails = [];
    this.setPhase("running");
    this.each("on.open", (m, f) => m.module.on?.open?.(f));
    // новый Host, а процесс запущен прежней версией SDK: перезапуск, ход не прерывается
    if (rec.sdk !== env.sdkVersion) void this.restart().catch(() => {});
  }

  private lostWith(stderr: string): Exit {
    return { code: null, signal: null, stderr };
  }

  private async drain(q: Query): Promise<void> {
    const messages = q[Symbol.asyncIterator]();
    for (;;) {
      let next: IteratorResult<SDKMessage, void>;
      try {
        next = await messages.next();
      } catch {
        return; // SDK называет выход процесса отказом; слова — в выходе от держателя
      }
      if (next.done) return;
      this.onMessage(next.value);
    }
  }

  /** Вывод процесса до конца, затем ended: выход — от держателя, дочитать остаток — не дольше ступени. */
  private async pump(q: Query, held: Promise<Held>): Promise<void> {
    const drained = this.drain(q);
    const exit = await (await held).exit;
    await limit(this.env.clock, drained, STEP_MS, () => undefined);
    this.ended(exit);
  }

  private onMessage(m: SDKMessage): void {
    if (m.type === "system" && m.subtype === "init") {
      this.model = m.model;
      if (m.session_id !== this.rec.session_id) {
        this.rec.session_id = m.session_id;
        this.env.saveRecords();
      }
    } else if (m.type === "system" && m.subtype === "session_state_changed") {
      this.turn = TURN_OF[m.state] ?? this.turn;
      this.changed();
    } else if (m.type === "result") this.wakeTurn();
    this.each("on.event", (mod, f) => mod.module.on?.event?.(f, m));
    this.refresh();
  }

  private wakeTurn(): void {
    for (const w of this.turnWaiters) w();
    this.turnWaiters.clear();
  }

  /** Процесс вышел. Ветка закрытого списка устава: один resume, второй сбой до готовности — failed; остановка ОС — без перезапуска. */
  private ended(exit: Exit): void {
    this.q = null;
    this.held = null;
    this.input.retire();
    this.wakeTurn();
    if (this.env.shutting() || this.closing) return;
    const { code, signal, stderr } = exit;
    const detail = `код ${code}${signal ? `, сигнал ${signal}` : ""}${stderr ? `: ${stderr}` : ""}`;
    if (exit.os_stop) {
      this.env.log({ ev: "session_os_stop", callsign: this.callsign, why: `остановка ОС: процесс claude вышел, ${detail}` });
      this.setPhase("stopped");
      return this.each("on.close", (m, f) => m.module.on?.close?.(f));
    }
    this.env.log({ kind: "stop", ev: "session_exited", callsign: this.callsign, why: `процесс claude вышел, ${detail}` });
    this.each("on.close", (m, f) => m.module.on?.close?.(f));
    this.fails.push(detail);
    if (this.fails.length >= 2) {
      this.env.log({ kind: "stop", ev: "session_failed", callsign: this.callsign, why: `второй сбой до готовности — сессия стоит до session.start: ${this.fails.join(" · ")}` });
      return this.setPhase("failed");
    }
    void this.relaunch().catch(() => {}); // отказ — её следующий выход, он снова придёт сюда
  }

  private async relaunch(point?: number): Promise<void> {
    this.setPhase("starting");
    await this.aim(point === undefined ? "resume" : "point", point);
    await this.launch();
  }

  // ───────────────── остановка и перезапуск ─────────────────

  private waitTurnEnd(ms: number): Promise<boolean> {
    return limit(this.env.clock, new Promise<boolean>((r) => this.turnWaiters.add(() => r(true))), ms, () => false);
  }

  private waitExit(ms: number): Promise<boolean> {
    return limit(this.env.clock, this.over.then(() => true), ms, () => false);
  }

  private async killProcess(why: string): Promise<void> {
    this.env.log({ kind: "stop", ev: "stop_late", callsign: this.callsign, why });
    this.held?.terminate();
    if (!(await this.waitExit(STEP_MS))) throw new Error(`${this.callsign}: процесс не вышел и через ${STEP_MS / 1000} с после kill`);
  }

  private async closeProcess(): Promise<void> {
    this.input.retire();
    this.q?.close();
    if (!(await this.waitExit(STEP_MS))) await this.killProcess(`нет выхода процесса после закрытия ввода за ${STEP_MS / 1000} с — kill`);
  }

  async stop(): Promise<void> {
    if (!this.rec.stopped) {
      this.rec.stopped = true;
      this.env.saveRecords();
    }
    if (this.phase === "stopped") return;
    if (!this.q) {
      this.env.log({ ev: "stop", callsign: this.callsign });
      return this.setPhase("stopped");
    }
    this.closing = true;
    this.setPhase("stopping");
    if (this.turn !== "idle") {
      void this.q.interrupt().catch(() => {}); // процесс умер раньше ответа: это увидит waitTurnEnd
      if (!(await this.waitTurnEnd(STEP_MS))) await this.killProcess(`нет итога хода после прерывания за ${STEP_MS / 1000} с — kill`);
    }
    if (this.q) await this.closeProcess();
    this.closing = false;
    this.env.log({ ev: "stop", callsign: this.callsign });
    this.setPhase("stopped");
    this.each("on.close", (m, f) => m.module.on?.close?.(f));
  }

  async restart(): Promise<void> {
    if (!this.q) return this.phase === "starting" ? undefined : this.start();
    if (this.turn !== "idle" && !(await this.waitTurnEnd(RESTART_WAIT_MS))) {
      this.env.log({ kind: "refuse", ev: "restart_late", callsign: this.callsign, why: `ход не кончился за ${RESTART_WAIT_MS / 3_600_000} ч — перезапуск отменён` });
      return;
    }
    if (!this.q || this.phase === "stopping") return;
    this.env.log({ ev: "restart", callsign: this.callsign });
    this.closing = true;
    await this.closeProcess();
    this.closing = false;
    this.each("on.close", (m, f) => m.module.on?.close?.(f));
    await this.relaunch();
  }

  async start(o: { point?: number } = {}): Promise<void> {
    if (this.q || this.phase === "starting") return;
    this.rec.stopped = false;
    this.env.saveRecords();
    this.fails = [];
    await this.relaunch(o.point);
  }

  async remove(): Promise<void> {
    await this.stop();
    this.listed = false;
    this.env.forget(this);
    this.env.send({ type: "session.state", callsign: this.callsign, state: null });
    this.env.log({ ev: "remove", callsign: this.callsign });
  }

  // ───────────────── решения ─────────────────

  private async decide(tool: string, input: Record<string, unknown>, opts: DecideOpts): Promise<PermissionResult> {
    const own = this.env.owners.has(`decide.${tool}`);
    const m = this.env.owners.get(own ? `decide.${tool}` : "decide.*");
    const deny = (word: string, why: string, module?: string): PermissionResult => {
      this.env.log({ kind: "refuse", ev: "decide", word, callsign: this.callsign, tool, why, ...(module ? { module } : {}) });
      return { behavior: "deny", message: word };
    };
    if (!m) return deny("unknown_request", `${tool}: у решения нет владельца — ответ за человека не выбран`);
    const answer = m.isOff(this)
      ? null
      : await this.env.trap.wait<PermissionResult | null>(m, this, `decide.${tool}`, () => m.module.decide![own ? tool : "*"](this.facade(m), input, own ? opts : { ...opts, tool }), null);
    return answer ?? deny("module_error", `${tool}: модуль ${m.name} выключен в ${this.callsign}`, m.name);
  }

  private async elicit(request: never, opts: { signal: AbortSignal; requestId: string }): Promise<{ action: "decline" }> {
    const m = this.env.owners.get("elicit");
    if (!m) {
      this.env.log({ ev: "elicit", callsign: this.callsign, why: "у форм MCP нет владельца — decline" });
      return { action: "decline" };
    }
    const decline = { action: "decline" } as const;
    return m.isOff(this) ? decline : (this.env.trap.wait(m, this, "elicit", () => m.module.elicit!(this.facade(m), request, opts), decline) as Promise<typeof decline>);
  }

  // ───────────────── сессия глазами модуля ─────────────────

  private pushInput(content: SDKUserMessage["message"]["content"], o: InputOpts = {}): void {
    if (o.from && o.from !== this.rec.from) {
      this.rec.from = o.from;
      this.env.saveRecords();
    }
    this.input.push({ type: "user", message: { role: "user", content }, parent_tool_use_id: null, ...(o.priority ? { priority: o.priority } : {}), ...(o.uuid ? { uuid: o.uuid } : {}), ...(o.origin ? { origin: o.origin } : {}) } as SDKUserMessage);
  }

  private sdkCall(mod: Mod, name: string, args: unknown[]): Promise<unknown> {
    if (!mod.manifest.calls?.includes(name)) return handled(Promise.reject(this.env.trap.violation(mod, this, `${name} нет в calls`)));
    const { session_id: sid, cwd: dir } = this.rec;
    const functions = this.env.sdk.functions;
    return handled((async () => {
      if (QUERY_METHODS.has(name)) {
        if (this.q) return (this.q as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[name](...args, ...(name === "renameSession" ? [sid] : []));
        if (!Object.hasOwn(SESSION_FUNCTIONS, name)) throw new Error(`${this.callsign}: процесс сессии не запущен`);
      }
      const before = SESSION_FUNCTIONS[name];
      const options = { dir, ...(args[before] as object | undefined) };
      return name === "getSessionMessages" ? wholeConversation(functions, sid, options) : functions[name](sid, ...args.slice(0, before), options);
    })());
  }

  private readField(mod: Mod, name: string): unknown {
    if (!mod.ref(name)) throw this.env.trap.violation(mod, this, `${name} нет в uses`);
    const owner = this.env.owners.get(name);
    return owner?.module.fields?.[name] ? this.fieldOf(owner, name) : undefined;
  }

  /** У каждого модуля свой объект: ядро знает, кто зовёт. */
  facade(mod: Mod): Session {
    let f = this.facades.get(mod);
    if (f) return f;
    const self = this;
    f = {
      get info() {
        return self.info;
      },
      get state() {
        return self.state;
      },
      input: (content, o) => this.pushInput(content, o),
      sdk: (name, ...args) => this.sdkCall(mod, name, args),
      // сбой запуска ведёт сама сессия: отказ промиса модуль может не ждать
      restart: () => handled(this.restart()),
      stop: () => handled(this.stop()),
      start: (o) => handled(this.start(o)),
      remove: () => handled(this.remove()),
      store: () => this.env.stores.section(mod.name, this.callsign),
      field: (name) => this.readField(mod, name),
      refresh: () => this.refresh(),
    };
    this.facades.set(mod, f);
    return f;
  }
}

