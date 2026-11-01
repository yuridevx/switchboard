// Сессия в ядре: один query() Agent SDK, очередь ввода, процесс у своего держателя, вклады модулей.
// Состояние — только из SDK (session_state_changed). Неожиданный выход процесса — один resume;
// второй сбой до готовности — failed, причина в журнале.
import type { HookCallbackMatcher, Options, Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { QueryPart, Session, SessionState, StartKind, Store } from "../contract.ts";
import type { Exited, HeldProcess } from "./holders.ts";
import { handled } from "./kernel.ts";
import type { Kernel, Mod } from "./kernel.ts";
import { InputQueue } from "./queue.ts";
import type { CoreRecord } from "./store.ts";

const SDK_STATE: Record<string, SessionState> = { idle: "idle", running: "busy", requires_action: "waiting" };
const LIVE = new Set<SessionState>(["idle", "busy", "waiting"]);
/** Опции query(), которые держит ядро: модулю их не взять. */
const CORE_OPTIONS = new Set([
  "prompt", "cwd", "resume", "sessionId", "forkSession", "continue", "permissionMode", "allowDangerouslySkipPermissions",
  "spawnClaudeCodeProcess", "canUseTool", "onElicitation", "systemPrompt", "abortController", "pathToClaudeCodeExecutable",
  "executable", "persistSession", "sessionStore",
]);
/** Ключи вклада, которые не опции query(). */
const PART_KEYS = new Set(["mcpServers", "env", "append", "settings", "hooks"]);

type Parts = Map<string, QueryPart>;
type First = { fresh?: boolean; resume?: string; fork?: boolean };

export class Sess {
  readonly k: Kernel;
  rec: CoreRecord;
  state: SessionState = "starting";
  queue = new InputQueue();
  q: Query | null = null;
  proc: HeldProcess | null = null;
  startKind: StartKind = "spawn";
  point: number | undefined;
  model: string | null = null;
  from: string | null = null;
  /** модули, выключенные в этой сессии: имя → причина */
  failed = new Map<string, string>();
  /** вклады модулей нынешнего query() */
  parts: Parts = new Map();
  /** события хуков, которые SDK получил в initialize этого query() */
  hookEvents = new Set<string>();
  ready = false;
  crashes = 0;
  launchSeq = 0;
  closing: null | "stop" | "restart" | "shutdown" = null;
  /** вызовы decide и elicit, ждущие человека */
  pending = new Set<{ mod: string; gen: number; run: () => void }>();
  private reasons: string[] = [];
  private resultWaiters: Array<() => void> = [];
  private exitWaiters: Array<() => void> = [];
  private settleWaiters: Array<() => void> = [];
  private lastSent = "";
  private facades = new Map<Mod, Session>();

  constructor(k: Kernel, rec: CoreRecord) {
    this.k = k;
    this.rec = rec;
  }

  get callsign(): string {
    return this.rec.callsign;
  }

  // ───────────── запуск ─────────────

  /** Вклады модулей в query(). Два владельца у сервера MCP, ключа env, settings или опции — исключение. */
  /** Вид старта до сборки вкладов: session() модуля уже видит s.info.start и point. */
  prepare(kind: StartKind, point?: number): void {
    this.startKind = kind;
    if (kind === "point") this.point = point;
    this.launchSeq = ++this.k.seq;
  }

  async collectParts(): Promise<Parts> {
    const parts: Parts = new Map();
    const owners = new Map<string, string>();
    const claim = (label: string, who: string) => {
      const o = owners.get(label);
      if (o && o !== who) throw new Error(`${label}: два владельца — ${o} и ${who}`);
      owners.set(label, who);
    };
    for (const m of this.k.mods) {
      if (!m.module.session || this.k.isDown(m, this)) continue;
      const p = (await this.k.invoke(m.name, "session", this, (x, mod) => x.session!(this.facade(mod)), () => undefined)) as QueryPart | undefined;
      if (!p) continue;
      const bad = Object.keys(p).find((key) => CORE_OPTIONS.has(key));
      if (bad) {
        this.k.disable(m, this, "session", new Error(`опция ${bad} — её держит ядро`));
        continue;
      }
      for (const n of Object.keys(p.mcpServers ?? {})) claim(`MCP-сервер ${n}`, m.name);
      for (const n of Object.keys(p.env ?? {})) claim(`env ${n}`, m.name);
      for (const n of Object.keys(p.settings ?? {})) claim(`settings ${n}`, m.name);
      for (const n of Object.keys(p)) if (!PART_KEYS.has(n) && p[n] !== undefined) claim(`опция ${n}`, m.name);
      parts.set(m.name, p);
    }
    return parts;
  }

  /** Обёртка ядра для хука: SDK знает только её, тело — хук нынешней версии модуля. */
  private hook(mod: string, ev: string, i: number, j: number) {
    return (input: unknown, toolUseID: string | undefined, o: { signal: AbortSignal }) =>
      Promise.resolve(
        this.k.invoke(mod, `hooks.${ev}`, this, () => {
          const h = (this.parts.get(mod)?.hooks as Record<string, HookCallbackMatcher[]> | undefined)?.[ev]?.[i]?.hooks[j];
          return h ? h(input as never, toolUseID, o) : {};
        }, () => ({})),
      );
  }

  private options(parts: Parts, attach: boolean, first?: First): Options {
    const mcpServers: Record<string, unknown> = {};
    const env: Record<string, string> = {};
    const settings: Record<string, unknown> = {};
    const appends: string[] = [];
    const hooks: Record<string, HookCallbackMatcher[]> = {};
    const extra: Record<string, unknown> = {};
    for (const [name, p] of parts) {
      Object.assign(mcpServers, p.mcpServers ?? {});
      Object.assign(env, p.env ?? {});
      Object.assign(settings, p.settings ?? {});
      if (p.append) appends.push(p.append);
      for (const [ev, list] of Object.entries(p.hooks ?? {})) {
        (list ?? []).forEach((mt, i) => {
          (hooks[ev] ??= []).push({
            ...(mt.matcher !== undefined ? { matcher: mt.matcher } : {}),
            ...(mt.timeout !== undefined ? { timeout: mt.timeout } : {}),
            hooks: mt.hooks.map((_, j) => this.hook(name, ev, i, j)),
          });
        });
      }
      for (const [key, v] of Object.entries(p)) if (!PART_KEYS.has(key) && v !== undefined) extra[key] = v;
    }
    this.parts = parts;
    this.hookEvents = new Set(Object.keys(hooks));
    let attachOnce = attach;
    const start: Record<string, unknown> = {};
    if (first?.fresh) start.sessionId = this.rec.session_id;
    else if (first?.resume && first.fork) Object.assign(start, { resume: first.resume, forkSession: true, sessionId: this.rec.session_id });
    else start.resume = this.rec.session_id;
    return {
      ...extra,
      ...start,
      cwd: this.rec.cwd,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      // состояние сессии — только из session_state_changed; SDK шлёт его лишь с этим ключом
      env: { ...process.env, ...env, DISABLE_UPDATES: "1", CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1" },
      systemPrompt: { type: "preset", preset: "claude_code", ...(appends.length ? { append: appends.join("\n\n") } : {}) },
      mcpServers: mcpServers as Options["mcpServers"],
      hooks,
      ...(Object.keys(settings).length ? { settings: settings as Options["settings"] } : {}),
      canUseTool: (tool, input, o) => this.k.canUseTool(this, tool, input, o as Record<string, unknown>),
      onElicitation: (req, o) => this.k.elicit(this, req, o),
      spawnClaudeCodeProcess: (o) => {
        const p = this.k.holders.channel(attachOnce ? "attach" : "spawn", this.callsign, o);
        attachOnce = false;
        this.proc = p;
        return p;
      },
    } as Options;
  }

  /**
   * Поднять процесс сессии: spawn нового, resume разговора, attach к живому у держателя.
   * Ответ — после initialize; процесс умер до него — исключение (ветку сбоя ведёт exited от держателя).
   */
  async launch(kind: StartKind, o: { parts?: Parts; first?: First } = {}): Promise<void> {
    const k = this.k;
    this.prepare(kind, kind === "point" ? this.point : undefined);
    this.ready = false;
    this.setState("starting");
    this.push();
    const attach = kind === "attach";
    if (!attach) {
      this.rec.sdk = k.sdkVersion;
      k.saveCore();
    }
    let parts: Parts;
    let first = o.first;
    try {
      parts = o.parts ?? (await this.collectParts());
      // файл разговора claude пишет на первом ходе: до него resume поднимать нечего — запуск с тем же id заново
      if (kind === "resume" && !first && !(await k.deps.sdk.functions.getSessionInfo(this.rec.session_id, { dir: this.rec.cwd })))
        first = this.rec.fork ? { resume: this.rec.fork, fork: true } : { fresh: true };
    } catch (e) {
      this.reasons.push((e as Error).message);
      this.fail();
      throw e;
    }
    const q = k.deps.sdk.query({ prompt: this.queue.stream(), options: this.options(parts, attach, first) });
    this.q = q;
    k.log("core", { ev: "launch", callsign: this.callsign, start: first?.fresh ? "spawn" : first?.fork ? "fork" : kind, sdk: this.rec.sdk, session_id: this.rec.session_id });
    void this.pump(q);
    try {
      await q.initializationResult();
    } catch (e) {
      throw new Error(`${this.callsign}: процесс вышел до initialize — ${(e as Error).message}`);
    }
    if (this.q !== q) throw new Error(`${this.callsign}: процесс сменился до initialize`);
    this.ready = true;
    this.crashes = 0;
    this.reasons = [];
    if (this.state === "starting") this.setState(attach && this.rec.state && LIVE.has(this.rec.state) ? this.rec.state : "idle");
    for (const m of k.mods) {
      if (m.module.on?.open) k.invoke(m.name, "on.open", this, (x, mod) => x.on!.open!(this.facade(mod)), () => undefined);
    }
    // процесс запущен прежним SDK: ход доходит до конца, затем resume с claude новой версии
    if (attach && this.rec.sdk !== k.sdkVersion) void this.restart().catch(() => {});
  }

  private async pump(q: Query): Promise<void> {
    try {
      for await (const m of q) this.onMessage(m);
    } catch {
      // конец потока: причину даст exited от держателя
    }
  }

  private onMessage(m: SDKMessage): void {
    const k = this.k;
    if (m.type === "system" && m.subtype === "init") {
      if (m.session_id && m.session_id !== this.rec.session_id) {
        this.rec.session_id = m.session_id;
        k.saveCore();
      }
      this.model = (m as { model?: string }).model ?? null;
    }
    if (m.type === "system" && m.subtype === "session_state_changed") {
      const st = SDK_STATE[(m as { state: string }).state];
      if (st && (LIVE.has(this.state) || this.state === "starting")) this.setState(st);
    }
    for (const mod of k.mods) {
      if (mod.module.on?.event) k.invoke(mod.name, "on.event", this, (x, cur) => x.on!.event!(this.facade(cur), m), () => undefined);
    }
    if (m.type === "result") for (const w of this.resultWaiters.splice(0)) w();
    this.push();
  }

  /** exited от держателя: наш close — ожидаемо; иначе сбой — один resume, второй до готовности — failed. */
  onExited(e: Exited): void {
    const why = `код ${e.code}${e.signal ? `, сигнал ${e.signal}` : ""}${e.stderr ? `: ${e.stderr}` : ""}`;
    const waiters = this.exitWaiters.splice(0);
    for (const w of waiters) w();
    if (this.closing || !this.q) return;
    this.q = null;
    this.proc = null;
    this.reasons.push(why);
    this.k.log("core", { kind: "stop", ev: "session_exited", callsign: this.callsign, why: `процесс claude вышел, ${why}` });
    this.emitClose();
    this.crashes = this.ready ? 1 : this.crashes + 1;
    if (this.crashes >= 2) return this.fail();
    void this.launch("resume").catch(() => {});
  }

  private fail(): void {
    this.q = null;
    this.setState("failed");
    this.k.log("core", {
      kind: "stop",
      ev: "session_failed",
      callsign: this.callsign,
      why: `второй сбой до готовности — сессия стоит до session.start: ${this.reasons.join(" · ")}`,
    });
  }

  /** Ждать, пока сессия поднимется или встанет. */
  settled(): Promise<void> {
    if (this.state !== "starting") return Promise.resolve();
    return new Promise((r) => this.settleWaiters.push(r));
  }

  nextResult(): Promise<void> {
    return new Promise((r) => this.resultWaiters.push(r));
  }

  setState(st: SessionState): void {
    if (this.state === st) return;
    this.state = st;
    if (LIVE.has(st)) {
      this.rec.state = st;
      this.k.saveCore();
    }
    if (st !== "starting") for (const w of this.settleWaiters.splice(0)) w();
    for (const m of this.k.mods) {
      if (m.module.on?.state) this.k.invoke(m.name, "on.state", this, (x, mod) => x.on!.state!(this.facade(mod), st), () => undefined);
    }
    this.push();
  }

  private emitClose(): void {
    for (const m of this.k.mods) {
      if (m.module.on?.close) this.k.invoke(m.name, "on.close", this, (x, mod) => x.on!.close!(this.facade(mod)), () => undefined);
    }
  }

  // ───────────── управление ─────────────

  private async closeQuery(): Promise<void> {
    const q = this.q;
    if (!q) return;
    const exited = new Promise<void>((r) => this.exitWaiters.push(r));
    this.q = null;
    q.close();
    await exited;
    this.proc = null;
  }

  private async interruptTurn(): Promise<void> {
    if (!this.q || (this.state !== "busy" && this.state !== "waiting")) return;
    const r = this.nextResult();
    await this.q.interrupt().catch(() => {});
    await r;
  }

  async stop(): Promise<void> {
    if (!this.q) {
      this.setState("stopped");
      this.rec.stopped = true;
      this.k.saveCore();
      return;
    }
    this.closing = "stop";
    try {
      await this.interruptTurn();
      this.setState("stopping");
      await this.closeQuery();
      this.rec.stopped = true;
      this.setState("stopped");
      this.k.saveCore();
      this.emitClose();
      this.k.log("core", { ev: "stop", callsign: this.callsign });
    } finally {
      this.closing = null;
    }
  }

  async restart(): Promise<void> {
    if (!this.q) return this.start();
    if (this.state === "busy" || this.state === "waiting") await this.nextResult();
    this.closing = "restart";
    try {
      await this.closeQuery();
      this.emitClose();
    } finally {
      this.closing = null;
    }
    this.k.log("core", { ev: "restart", callsign: this.callsign });
    await this.launch("resume");
  }

  async start(o: { point?: number } = {}): Promise<void> {
    if (this.q) return;
    this.rec.stopped = false;
    this.crashes = 0;
    this.reasons = [];
    this.point = o.point;
    this.k.saveCore();
    await this.launch(o.point !== undefined ? "point" : "resume");
  }

  async remove(): Promise<void> {
    await this.stop();
    this.k.sessions.delete(this.callsign);
    this.k.saveCore();
    this.k.stores.removeSession(this.callsign);
    this.k.send({ type: "session.state", callsign: this.callsign, state: null });
    this.k.log("core", { ev: "remove", callsign: this.callsign });
  }

  /** Штатная остановка Host: процесс остаётся у своего держателя, новый Host подключится к нему. */
  shutdown(): void {
    if (this.q) this.closing = "shutdown";
  }

  // ───────────── roster ─────────────

  /** Запись сессии в roster: поля ядра и поля модулей; выключенные модули — в failed. */
  record(): Record<string, unknown> {
    const k = this.k;
    const r: Record<string, unknown> = { callsign: this.callsign, state: this.state, sdk: this.rec.sdk };
    for (const m of k.mods) {
      for (const name of Object.keys(m.module.fields ?? {})) {
        if (k.isDown(m, this)) continue;
        const v = k.invoke(m.name, `fields.${name}`, this, (x, mod) => x.fields![name](this.facade(mod)), () => undefined);
        if (v !== undefined && typeof (v as Promise<unknown>)?.then !== "function") r[name] = v;
      }
    }
    const failed: Record<string, string> = {};
    for (const m of k.mods) if (m.down) failed[m.name] = m.down;
    for (const [n, why] of this.failed) failed[n] = why;
    if (Object.keys(failed).length) r.failed = failed;
    return r;
  }

  helloRecord(): Record<string, unknown> {
    const r = this.record();
    this.lastSent = JSON.stringify(r);
    return r;
  }

  /** Поля или состояние изменились — session.state в relay. */
  push(): void {
    if (!this.k.sessions.has(this.callsign)) return;
    const r = this.record();
    const j = JSON.stringify(r);
    if (j === this.lastSent) return;
    this.lastSent = j;
    this.k.send({ type: "session.state", ...r } as never);
  }

  // ───────────── сессия глазами модуля ─────────────

  facade(m: Mod): Session {
    let f = this.facades.get(m);
    if (f) return f;
    const s = this;
    const k = this.k;
    f = {
      get info() {
        // модуль, загруженный после старта процесса, видит сессию как после перезапуска Host
        const start: StartKind = m.seq > s.launchSeq ? "attach" : s.startKind;
        return {
          callsign: s.callsign,
          session_id: s.rec.session_id,
          cwd: s.rec.cwd,
          model: s.model,
          sdk: s.rec.sdk,
          from: s.from,
          start,
          ...(start === "point" && s.point !== undefined ? { point: s.point } : {}),
        };
      },
      get state() {
        return s.state;
      },
      input(content, o = {}) {
        if (o.from !== undefined) s.from = o.from;
        s.queue.push({
          type: "user",
          message: { role: "user", content },
          parent_tool_use_id: null,
          ...(o.priority ? { priority: o.priority } : {}),
          ...(o.uuid ? { uuid: o.uuid as `${string}-${string}-${string}-${string}-${string}` } : {}),
          ...(o.origin !== undefined ? { origin: o.origin as never } : {}),
        });
      },
      sdk: (name, ...args) => handled(k.sessionSdk(m, s, name, args)),
      // сбой запуска ведёт сама сессия (exited → resume → failed): отказ промиса модуль может не ждать
      restart: () => handled(s.restart()),
      stop: () => handled(s.stop()),
      start: (o) => handled(s.start(o)),
      remove: () => handled(s.remove()),
      store: <T>() => k.stores.session<T>(m.name, s.callsign) as Store<T>,
      refresh: () => s.push(),
    };
    this.facades.set(m, f);
    return f;
  }
}
