// Ядро Host: реестр модулей и их вызов, старт и остановка, вход кадров и запросов, фасад Host. О функциях не знает.
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { ownerOf } from "@switchboard/manifest-gate";
import { READ_MS, accepts, hostOf, machineOf, serviceAddress, type Frame } from "@switchboard/protocol";
import { fleet, type FleetClient, type Roster, type WsCtor } from "@switchboard/relay";
import type { Host, LogRecord, Manifest, Module, OpenSpec, Probe, QueryPart, Result, Session as View } from "../contract.ts";
import { realClock, within, type Clock } from "./clock.ts";
import { coreOption, mergeParts, moduleFlaws, setProblems, usesName, type Merged } from "./gate.ts";
import { Holders, type HolderApi, type HoldFile } from "./holders.ts";
import { isRefusal, refuse } from "./refusal.ts";
import type { ModuleEntry, Release } from "./release.ts";
import { Session, quiet } from "./session.ts";
import { Disk } from "./store.ts";

/** Предел вызова модуля на старте и открытии: вдвое выше самого долгого старта Host (5,9 с). */
const MODULE_MS = 12_000;
const SHUTDOWN_MS = 30_000;
const KILL_MS = 30_000;
/** Окружение машины, которое доходит до claude; остальное про Claude подброшено мимо Host. */
const OWN_ENV = /^(CLAUDE|ANTHROPIC)_/i;
const KEPT_ENV = new Set(["CLAUDE_CODE_GIT_BASH_PATH", "CLAUDE_CONFIG_DIR"]);
const PASS_REFUSED = new Set(["revoked", "bad_key"]);

export type HostConfig = { machine: string; modules?: Record<string, unknown> };
export type Sdk = {
  query(p: { prompt: AsyncIterable<any>; options: Record<string, unknown> }): any;
  functions: Record<string, (...a: any[]) => Promise<any>>;
  cli(args: string[], env: Record<string, string | undefined>, input?: string): Promise<{ code: number | null; out: string }>;
  bin?: string;
};
export type KernelOptions = {
  home: string;
  config: HostConfig;
  core: Manifest;
  release: Release;
  sdk: Sdk;
  holders: HolderApi;
  relayKey?: string;
  WebSocket?: WsCtor;
  fetch?: typeof fetch;
  clock?: Clock;
  exit?: (code: number) => void;
  pauseMs?: number;
};
/** Вклады модулей в query() одной сессии. */
export type Parts = { merged: Merged; hooks: Record<string, unknown[]>; conflicts: string[] };

export class StartError extends Error {
  readonly reasons: string[];
  constructor(reasons: string[]) {
    super(reasons.join("; "));
    this.reasons = reasons;
  }
}

export class Mod {
  /** причина выключения на машине */
  failed: string | null = null;
  readonly manifest: Manifest;
  readonly module: Module;
  constructor(manifest: Manifest, module: Module) {
    this.manifest = manifest;
    this.module = module;
  }
  get name(): string {
    return this.manifest.name;
  }
}

/** Чей код сейчас идёт: ловушка процесса отдаёт ошибку тому, кто начал работу. */
const scope = new AsyncLocalStorage<{ mod: Mod; session?: Session }>();

export class Kernel {
  readonly sessions = new Map<string, Session>();
  readonly mods: Mod[];
  readonly byName: Map<string, Mod>;
  readonly holders: Holders;
  readonly disk: Disk;
  readonly clock: Clock;
  readonly sdk: Sdk;
  readonly version: string;
  relay: FleetClient | null = null;
  shutting: Promise<void> | undefined;
  private machine: string;
  private owners = new Map<string, Mod>();
  /** имена запросов и их версии */
  private served: Record<string, number> = {};
  private abort = new AbortController();
  private inflight = new Set<Promise<unknown>>();
  private probes = new Set<Probe>();
  private hosts = new Map<Mod, Host>();
  private seen = new WeakSet<object>();
  private roster: Roster | null = null;
  private o: KernelOptions;

  constructor(o: KernelOptions) {
    this.o = o;
    this.machine = o.config.machine;
    this.clock = o.clock ?? realClock;
    this.sdk = o.sdk;
    this.version = o.release.sdk;
    this.holders = new Holders(o.holders);
    this.disk = new Disk(join(o.home, "store"));
    this.mods = o.release.modules.map((e) => new Mod(e.manifest, e.module));
    this.byName = new Map(this.mods.map((m) => [m.name, m]));
    for (const m of this.mods) {
      for (const name of Object.keys(m.manifest.provides)) {
        if (!this.owners.has(name)) this.owners.set(name, m);
        if (m.module.requests?.[name]) this.served[name] = m.manifest.provides[name];
      }
    }
  }

  // ───────────────────────── журнал и хранилище ─────────────────────────

  private write(who: string, { kind = "note", ...r }: LogRecord): void {
    const t = new Date(this.clock.now()).toISOString();
    const dir = join(this.o.home, "journal");
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, `host-${t.slice(0, 10)}.jsonl`), `${JSON.stringify({ t, part: "host", machine: this.machine, who, kind, ...r })}\n`);
  }

  log(r: LogRecord): void {
    this.write("host", r);
  }

  save(): void {
    this.disk.saveRecords([...this.sessions.values()].map((s) => s.rec));
  }

  // ───────────────────────── вызов модуля ─────────────────────────

  off = (m: Mod, s?: Session): boolean => m.failed !== null || !!s?.failed.has(m.name);

  private switchOff(m: Mod, s: Session | undefined, where: string, message: string, text = message): void {
    if (this.off(m, s)) return;
    const reason = `${message} · ${where}`;
    if (s) s.failed.set(m.name, reason);
    else m.failed = reason;
    this.log({ kind: "stop", ev: "module_failed", word: "module_error", module: m.name, callsign: s?.callsign, why: `${m.name}: ${where} — ${text}; модуль выключен ${s ? "в сессии" : "на машине"}` });
    for (const x of s ? [s] : this.sessions.values()) x.sync();
  }

  private fail(m: Mod, s: Session | undefined, where: string, e: unknown): void {
    if (typeof e === "object" && e !== null) {
      if (this.seen.has(e)) return;
      this.seen.add(e);
    }
    if (isRefusal(e)) this.write(m.name, { kind: "refuse", ev: where, word: e.word, why: e.why, callsign: s?.callsign });
    else this.switchOff(m, s, where, e instanceof Error ? e.message : String(e), String(e));
  }

  /** Единственный вход в код модуля: контекст для ловушки; бросок — отказ словом в журнал или модуль выключен. */
  private run<T>(m: Mod, s: Session | undefined, where: string, fn: () => T): T | undefined {
    try {
      const r = scope.run({ mod: m, session: s }, fn);
      return (r instanceof Promise ? r.catch((e: unknown) => this.fail(m, s, where, e)) : r) as T;
    } catch (e) {
      this.fail(m, s, where, e);
      return undefined;
    }
  }

  /** То же с пределом: модуль не вернулся — выключен, идём дальше без него. */
  private bounded<T>(m: Mod, s: Session | undefined, where: string, fn: () => T | Promise<T>): Promise<T | undefined> {
    const late = () => {
      this.switchOff(m, s, where, `${where}() не вернулся за ${MODULE_MS / 1000} с`);
      return undefined;
    };
    return within<T | undefined>(this.clock, Promise.resolve(this.run(m, s, where, fn)), MODULE_MS, late);
  }

  /** Вызов всем живым модулям сессии по порядку списка. */
  each(s: Session, where: string, fn: (mod: Module, view: View) => void): void {
    for (const m of this.mods) if (!this.off(m, s)) this.run(m, s, where, () => fn(m.module, s.facade(m)));
  }

  /** Нарушение договора: модуль выключен там, где нарушил; ошибку получает он сам, вторая строка не пишется. */
  violate(m: Mod, why: string, s = scope.getStore()?.session): Error {
    const e = new Error(why);
    this.fail(m, s, "договор", e);
    return e;
  }

  /** Ошибка вне вызова ядра: true — она модуля и он выключен там, где начал работу; false — ничья, решает процесс. */
  stray(e: unknown): boolean {
    const at = scope.getStore();
    if (at) this.fail(at.mod, at.session, "работа вне вызова ядра", e);
    return !!at;
  }

  failedOnMachine(): Record<string, string> {
    return Object.fromEntries(this.mods.flatMap((m) => (m.failed === null ? [] : [[m.name, m.failed]])));
  }

  fieldsOf(s: Session): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const m of this.mods) {
      for (const [name, fn] of Object.entries(m.module.fields ?? {})) {
        if (this.off(m, s)) break;
        const v = this.run(m, s, `fields.${name}`, () => fn(s.facade(m)));
        if (!this.off(m, s)) out[name] = v;
      }
    }
    return out;
  }

  field(m: Mod, s: Session, name: string): unknown {
    const ref = usesName(m.manifest, name);
    const own = m.manifest.provides[name] !== undefined;
    if (!own && !ref) throw this.violate(m, `${name} нет в uses`, s);
    const owner = own ? m : this.byName.get(ownerOf(ref!));
    const fn = owner?.module.fields?.[name];
    return owner && fn && !this.off(owner, s) ? this.run(owner, s, `fields.${name}`, () => fn(s.facade(owner))) : undefined;
  }

  // ───────────────────────── вклады в query() ─────────────────────────

  async parts(s: Session): Promise<Parts> {
    const call = async (m: Mod) => {
      try {
        return await m.module.session!(s.facade(m));
      } catch (e) {
        throw isRefusal(e) ? new Error(`отказ ${e.word} в session(): ${e.why}`) : e;
      }
    };
    const live = this.mods.filter((m) => m.module.session && !this.off(m, s));
    const got = await Promise.all(live.map((m) => this.bounded(m, s, "session", () => call(m))));
    const taken: Array<[Mod, QueryPart]> = [];
    live.forEach((m, i) => {
      const part = got[i];
      const core = part && coreOption(part);
      if (core) this.switchOff(m, s, "session", `опция ${core} — её держит ядро`);
      else if (part && !this.off(m, s)) taken.push([m, part]);
    });
    const hooks: Parts["hooks"] = {};
    for (const [m, part] of taken) {
      for (const [event, matchers] of Object.entries(part.hooks ?? {})) {
        const wrap = (h: (...a: any[]) => Promise<unknown>) => async (...a: unknown[]) => (this.off(m, s) ? {} : ((await this.run(m, s, `hooks.${event}`, () => h(...a))) ?? {}));
        (hooks[event] ??= []).push(...matchers!.map((x) => ({ ...x, hooks: x.hooks.map(wrap) })));
      }
    }
    return { ...mergeParts(taken.map(([m, part]) => [m.name, part])), hooks };
  }

  private env(extra?: Record<string, string>): Record<string, string | undefined> {
    return { ...process.env, ...extra, DISABLE_UPDATES: "1" };
  }

  queryOptions(s: Session, { merged, hooks }: Parts, own: Record<string, unknown>): Record<string, unknown> {
    const { env, mcpServers, settings, options, append } = merged;
    return {
      permissionMode: "bypassPermissions",
      ...options,
      ...own,
      allowDangerouslySkipPermissions: true,
      cwd: s.rec.cwd,
      env: { ...this.env(env), CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1" },
      mcpServers,
      hooks,
      ...(Object.keys(settings).length ? { settings } : {}),
      systemPrompt: { type: "preset", preset: "claude_code", ...(append.length ? { append: append.join("\n\n") } : {}) },
      pathToClaudeCodeExecutable: this.sdk.bin,
      canUseTool: (tool: string, input: Record<string, unknown>, opts: Record<string, unknown>) => this.decide(s, tool, input, opts),
      onElicitation: (request: never, opts: never) => this.elicit(s, request, opts),
    };
  }

  private async decide(s: Session, tool: string, input: Record<string, unknown>, opts: Record<string, unknown>): Promise<unknown> {
    const name = this.owners.has(`decide.${tool}`) ? tool : "*";
    const m = this.owners.get(`decide.${name}`);
    const deny = (word: string, why: string) => {
      this.log({ kind: "refuse", ev: "decide", word, callsign: s.callsign, tool, module: m?.name, why });
      return { behavior: "deny", message: word };
    };
    if (!m) return deny("unknown_request", `${tool}: у решения нет владельца — ответ за человека не выбран`);
    if (this.off(m, s)) return deny("module_error", `${tool}: модуль ${m.name} выключен`);
    const where = `decide.${name}`;
    const answer = await this.run(m, s, where, () => m.module.decide![name](s.facade(m), input, { ...opts, tool } as never));
    return answer ?? deny("module_error", `${tool}: решение ${m.name} не состоялось`);
  }

  private async elicit(s: Session, request: never, opts: never): Promise<unknown> {
    const m = this.owners.get("elicit");
    if (!m) this.log({ ev: "elicit", callsign: s.callsign, why: "у форм MCP нет владельца — decline" });
    const answer = m && !this.off(m, s) ? await this.run(m, s, "elicit", () => m.module.elicit!(s.facade(m), request, opts)) : undefined;
    return answer ?? { action: "decline" };
  }

  // ───────────────────────── старт ─────────────────────────

  /** Только свои переменные: подброшенное на машине не доходит до процессов; папка Claude — своя. */
  private ownEnv(): void {
    const dropped = Object.keys(process.env).filter((k) => OWN_ENV.test(k) && !KEPT_ENV.has(k));
    for (const k of dropped) delete process.env[k];
    if (dropped.length) this.log({ ev: "env_dropped", why: `стёрто из окружения: ${dropped.join(", ")}` });
    process.env.CLAUDE_CONFIG_DIR = join(this.o.home, "claude");
    mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
  }

  private refuseStart(reasons: string[]): void {
    if (!reasons.length) return;
    for (const why of reasons) this.log({ kind: "stop", ev: "gate", word: "check_failed", why });
    throw new StartError(reasons);
  }

  async start(): Promise<void> {
    const { release, core } = this.o;
    this.log({ ev: "host_start", version: release.version, sdk: release.sdk, modules: this.mods.map((m) => `${m.name} ${m.manifest.version}`) });
    this.ownEnv();
    this.refuseStart(setProblems(core, release.modules, release.workers));
    release.modules.forEach((e: ModuleEntry, i) => {
      const flaws = [...(e.failed ? [e.failed] : []), ...moduleFlaws(e.manifest, e.module)];
      if (flaws.length) this.switchOff(this.mods[i], undefined, "гейт старта", flaws.join("; "));
    });
    for (const m of this.mods) if (m.module.start && !this.off(m)) await this.bounded(m, undefined, "start", () => m.module.start!(this.facade(m)));

    const files = this.holders.files();
    for (const rec of this.disk.records()) this.sessions.set(rec.callsign, new Session(this, rec, !rec.stopped && files.some((f) => f.id === rec.callsign) ? "attach" : "resume"));
    const live = [...this.sessions.values()].filter((s) => !s.rec.stopped);
    const parts = await Promise.all(live.map((s) => this.parts(s)));
    this.refuseStart(parts.flatMap((p) => p.conflicts));

    this.connect();
    const work = [
      ...files.filter((f) => !live.some((s) => s.callsign === f.id)).map((f) => this.killOrphan(f)),
      ...live.map((s, i) => {
        quiet(s.launch(s.startKind, parts[i]));
        return s.settled();
      }),
    ];
    await Promise.race([Promise.all(work), new Promise((r) => this.abort.signal.addEventListener("abort", r))]);
    if (this.abort.signal.aborted) return;
    this.log({ ev: "ready", version: release.version });
    for (const m of this.mods) if (!this.off(m)) this.run(m, undefined, "on.ready", () => m.module.on?.ready?.());
  }

  /** Процесс, которого нет в списке сессий: kill, старт ждёт его выхода с пределом. */
  private async killOrphan(f: HoldFile): Promise<void> {
    this.log({ kind: "stop", ev: "orphan_kill", callsign: f.id, why: `процесс ${f.id} (pid ${f.pid}) не в списке сессий — kill` });
    const h = this.holders.connect(f);
    h.destroy();
    const late = () => this.log({ kind: "stop", ev: "orphan_late", callsign: f.id, why: `держатель ${f.id} не вышел за ${KILL_MS / 1000} с после kill — старт идёт дальше` });
    await within<unknown>(this.clock, h.exited, KILL_MS, late);
  }

  // ───────────────────────── связь ─────────────────────────

  private connect(): void {
    const { release, relayKey, WebSocket, fetch, pauseMs } = this.o;
    if (!release.workers.relay) return;
    const contract = Object.assign({}, ...this.mods.map((m) => m.manifest.provides)) as Record<string, number>;
    this.relay = fleet({
      workers: release.workers,
      key: relayKey ?? "",
      machine: this.machine,
      hello: () => ({ sdk: release.sdk, contract, sessions: [...this.sessions.values()].map((s) => s.hello()) }),
      onFrame: (f) => this.onFrame(f),
      onState: (m, state, why) => this.onLink(m, state, why),
      onLost: (f, word) => this.log({ ev: f.type, word, why: `${f.type} → ${String(f.to)} не дошёл: ${word}` }),
      WebSocket,
      fetch,
      pauseMs,
    });
  }

  private onLink(m: string, state: string, why = ""): void {
    if (this.shutting) return;
    if (m !== this.machine) {
      if (state === "open" && m) this.log({ ev: "guest_open", why: m });
      if (state === "closed" || state === "stopped") this.log({ ev: "guest_closed", why: m ? `${m} · ${why}` : `keys.list: ${why}` });
    } else if (state === "open") {
      this.log({ ev: "hello", why: "hello принят" });
      for (const s of this.sessions.values()) s.sync();
    } else if (state === "closed") {
      this.log({ ev: "relay_closed", why });
    } else if (state === "stopped") {
      this.log({ kind: "stop", ev: "relay_stopped", word: why, why: `relay закрыл соединение: ${why} — Host не переподключается` });
      if (PASS_REFUSED.has(why)) void this.shutdown(`relay не принял пропуск машины: ${why}`);
    }
  }

  send(f: Frame): boolean {
    return !!this.relay?.send(f).ok;
  }

  private onFrame(f: Frame): void {
    if (f.id) {
      const work = this.serve(f).then((r) => void this.relay?.send({ ...r, type: "reply", id: f.id, to: f.from }));
      this.inflight.add(work);
      void work.finally(() => this.inflight.delete(work));
      return;
    }
    if (f.type === "roster") this.roster = this.relay!.roster;
    const frame = f.type === "roster" ? (this.roster as unknown as Frame) : f;
    const listeners = this.mods.filter((m) => m.module.on?.frame && usesName(m.manifest, f.type) && !this.off(m));
    const owner = this.owners.get(f.type);
    const handler = owner?.module.frames?.[f.type];
    if (!handler && !listeners.length && f.type !== "roster") this.log({ kind: "refuse", ev: "frame", word: "unknown_request", why: `кадр ${f.type}: владельца нет` });
    if (this.shutting) return;
    const s = this.sessions.get(String(f.callsign ?? f.to));
    if (handler && !this.off(owner!, s)) this.run(owner!, s, `frames.${f.type}`, () => handler(f, this.ctx(owner!, f)));
    for (const m of listeners) this.run(m, undefined, "on.frame", () => m.module.on!.frame!(frame));
  }

  private ctx(m: Mod, f: Frame) {
    return { host: this.facade(m), from: f.from, signal: this.abort.signal };
  }

  /** Запрос владельцу на этой машине: от relay и от модуля — одна дорога. */
  private serve(f: Frame): Promise<Result> {
    const refused = (word: string, why: string, module?: string): Promise<Result> => {
      this.log({ kind: "refuse", ev: "request", word, why, callsign: f.callsign as string | undefined, module });
      return Promise.resolve({ ok: false, error: word });
    };
    if (this.shutting) return refused("shutting_down", `${f.type}: Host останавливается`);
    const bad = accepts(f, this.served);
    if (bad) return refused(bad.word, bad.why);
    const s = this.sessions.get(f.callsign as string);
    if (f.callsign !== undefined && !s) return refused("offline", `${f.type}: сессии ${String(f.callsign)} нет`);
    const m = this.owners.get(f.type)!;
    if (this.off(m, s)) return refused("module_error", `${f.type}: модуль ${m.name} выключен${m.failed === null ? ` в ${s!.callsign}` : ""}`, m.name);
    return (async (): Promise<Result> => {
      try {
        return { ok: true, result: await scope.run({ mod: m, session: s }, () => m.module.requests![f.type](f, this.ctx(m, f))) };
      } catch (e) {
        if (!isRefusal(e)) {
          this.fail(m, s, `requests.${f.type}`, e);
          return { ok: false, error: "module_error" };
        }
        this.write(m.name, { kind: "refuse", ev: "request", word: e.word, why: e.why, callsign: s?.callsign });
        return { ok: false, error: e.word, ...(e.why ? { why: e.why } : {}) };
      }
    })();
  }

  private async request(m: Mod, name: string, payload: Record<string, unknown>, read: boolean): Promise<Result> {
    const ref = usesName(m.manifest, name);
    const own = m.manifest.provides[name] !== undefined;
    if (!own && !ref) throw this.violate(m, `${name} нет в uses`);
    const f: Frame = { ...payload, type: name, v: (payload.v as number | undefined) ?? (own ? m.manifest.provides[name] : m.manifest.uses[ref!]) };
    const owner = own ? m.name : ownerOf(ref!);
    const target = hostOf(f);
    if (this.byName.has(owner) && !Array.isArray(f.to) && (target == null || target === this.machine)) {
      const local = this.serve({ ...f, from: f.from ?? `@${this.machine}` });
      return read ? within<Result>(this.clock, local, READ_MS, () => ({ ok: false, error: "timeout" })) : local;
    }
    if (!this.relay) return { ok: false, error: "disconnected" };
    if (this.o.release.workers[owner]) f.to ??= serviceAddress(owner);
    const { type: _t, id: _i, to: _to, from: _f, ...reply } = await this.relay.request(f, read);
    return reply as Result;
  }

  private emit(m: Mod, f: Frame): Result {
    const ref = usesName(m.manifest, f.type);
    const version = m.manifest.provides[f.type] ?? (ref ? m.manifest.uses[ref] : undefined);
    if (version === undefined) throw this.violate(m, `${f.type} нет в provides и uses`);
    return this.relay ? this.relay.send({ v: version, ...f }) : { ok: false, error: "disconnected" };
  }

  // ───────────────────────── сессии ─────────────────────────

  private async opening(s: Session, request: Record<string, unknown>): Promise<void> {
    for (const m of this.mods) {
      const { opening, openingReads: reads } = m.module;
      if (!opening) continue;
      const unread = () => refuse("module_error", `${m.name} выключен: запрос открытия ${s.callsign} не прочитан`);
      if (this.off(m, s)) {
        if (!reads || reads.some((k) => request[k] !== undefined)) throw unread();
        continue;
      }
      let refusal: unknown;
      const call = async () => {
        try {
          await opening(s.facade(m), request);
        } catch (e) {
          if (!isRefusal(e)) throw e;
          refusal = e;
        }
      };
      await this.bounded(m, s, "opening", call);
      if (refusal) throw refusal;
      if (this.off(m, s)) throw unread();
    }
  }

  async open(spec: OpenSpec): Promise<Session> {
    const { callsign, cwd, resume, point } = spec;
    const copy = spec.fork && resume;
    if (this.shutting) throw refuse("shutting_down");
    if (machineOf(callsign) !== this.machine) throw new Error(`${callsign}: callsign не этой машины`);
    if (this.sessions.has(callsign)) throw new Error(`${callsign}: имя занято`);
    const rec = { callsign, cwd, session_id: resume && !copy ? resume : randomUUID(), sdk: this.version, stopped: false, ...(copy ? { fork: copy } : {}) };
    const kind = copy ? "fork" : point !== undefined ? "point" : resume ? "resume" : "spawn";
    const s = new Session(this, rec, kind === "fork" ? "resume" : kind, point);
    let parts: Parts;
    try {
      await this.opening(s, spec.opening ?? {});
      parts = await this.parts(s);
      if (parts.conflicts.length) {
        const why = parts.conflicts.join("; ");
        this.log({ kind: "stop", ev: "open", callsign, why });
        throw new Error(why);
      }
      if (spec.mkdir) this.mkdir(callsign, cwd);
    } catch (e) {
      this.disk.dropSession(callsign);
      throw e;
    }
    this.sessions.set(callsign, s);
    this.save();
    this.log({ ev: "open", callsign, cwd });
    s.sync();
    await s.launch(kind, parts);
    return s;
  }

  private mkdir(callsign: string, cwd: string): void {
    try {
      mkdirSync(cwd, { recursive: true });
    } catch (e) {
      throw refuse("bad_dir", `${callsign}: папка ${cwd} не создана — ${(e as Error).message}`);
    }
  }

  /** Сессия убрана: записи и разделов нет, relay снимает её. */
  forget(s: Session): void {
    this.sessions.delete(s.callsign);
    this.disk.dropSession(s.callsign);
    this.save();
    this.log({ ev: "remove", callsign: s.callsign });
    this.send({ type: "session.state", callsign: s.callsign, state: null });
  }

  // ───────────────────────── фасад ─────────────────────────

  private probe(m: Mod, o: { env?: Record<string, string> } = {}): Probe {
    let finish = () => {};
    const closed = new Promise<void>((r) => (finish = r));
    const prompt = (async function* () {
      await closed;
    })();
    const q = this.sdk.query({ prompt, options: { env: this.env(o.env), permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true, pathToClaudeCodeExecutable: this.sdk.bin } });
    const probe: Probe = {
      sdk: (name, ...args) => (m.manifest.calls?.includes(name) ? q[name](...args) : quiet(Promise.reject(this.violate(m, `${name} нет в calls`)))),
      close: () => {
        this.probes.delete(probe);
        finish();
        q.close();
      },
    };
    this.probes.add(probe);
    return probe;
  }

  /** Host глазами модуля: у каждого свой, ядро знает, кто зовёт. */
  facade(m: Mod): Host {
    let host = this.hosts.get(m);
    if (!host) {
      const { home, release, config } = { home: this.o.home, release: this.o.release, config: this.o.config };
      host = {
        machine: this.machine,
        dataDir: home,
        version: release.version,
        sdk: release.sdk,
        session: (callsign) => this.sessions.get(callsign)?.facade(m),
        sessions: () => [...this.sessions.values()].map((s) => ({ callsign: s.callsign, cwd: s.rec.cwd, state: s.state })),
        open: async (spec) => (await this.open(spec)).facade(m),
        request: (name, payload) => quiet(this.request(m, name, payload, false)),
        read: (name, payload) => quiet(this.request(m, name, payload, true)),
        emit: (f) => this.emit(m, f),
        store: <T>() => this.disk.section<T>(m.name),
        config: <T>() => (config.modules?.[m.name] ?? {}) as T,
        log: (r) => this.write(m.name, r),
        probe: (o) => this.probe(m, o),
        cli: (args, o = {}) => this.sdk.cli(args, this.env(o.env), o.input),
        roster: () => this.roster,
      };
      this.hosts.set(m, host);
    }
    return host;
  }

  /** То же под именем стенда. */
  hostFacade(m: Mod): Host {
    return this.facade(m);
  }

  // ───────────────────────── остановка ─────────────────────────

  /** Штатная остановка: повторный сигнал получает ту же. */
  shutdown(why: string): Promise<void> {
    return (this.shutting ??= Promise.resolve().then(() => this.down(why)));
  }

  private async down(why: string): Promise<void> {
    this.log({ ev: "shutdown", why: `остановка: ${why}` });
    this.abort.abort();
    let waits = "начатые запросы";
    const work = async () => {
      await Promise.allSettled(this.inflight);
      for (const m of [...this.mods].reverse()) {
        if (!m.module.stop || this.off(m)) continue;
        waits = `stop() модуля ${m.name}`;
        await this.run(m, undefined, "stop", () => m.module.stop!());
      }
      return 0;
    };
    const late = () => {
      this.log({ kind: "stop", ev: "shutdown_late", why: `остановка не успела за ${SHUTDOWN_MS / 1000} с: ждёт ${waits} — жёсткий выход 1 · ${why}` });
      return 1;
    };
    const code = await within(this.clock, work(), SHUTDOWN_MS, late);
    for (const p of [...this.probes]) p.close();
    this.relay?.close(1000, "shutting_down");
    this.holders.close();
    if (code === 0) this.log({ ev: "exit", why: `выход 0 · ${why}` });
    this.o.exit?.(code);
  }
}
