// Ядро Host: модули, сессии, связь с keeper и relay, реестр владельцев, ловушка ошибок,
// штатная остановка и перезагрузка модулей на ходу. Само ничего не решает: находит владельца и передаёт ему.
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { ElicitationResult, Options, PermissionResult, Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { fail, isReply, machineOf, ok } from "@switchboard/protocol";
import type { Frame, Reply } from "@switchboard/protocol";
import { link } from "@switchboard/relay";
import type { Link, LinkState, WsCtor } from "@switchboard/relay";
import { Refusal } from "./refusal.ts";
import type {
  Host,
  LogRecord,
  Manifest,
  Module,
  OpenSpec,
  Probe,
  ReloadResult,
  Result,
  Session,
  Store,
} from "../contract.ts";
import { SESSION_FUNCTIONS } from "./calls.ts";
import type { Clock } from "./clock.ts";
import { realClock } from "./clock.ts";
import { journal } from "./journal.ts";
import type { Journal } from "./journal.ts";
import { KeeperClient } from "./keeper.ts";
import type { Exited, KeeperAddr } from "./keeper.ts";
import { InputQueue } from "./queue.ts";
import { gate, nameOf, ownerOf } from "./registry.ts";
import type { Release } from "./release.ts";
import { Sess } from "./session.ts";
import { Stores } from "./store.ts";
import type { CoreRecord } from "./store.ts";

/** ~/.switchboard/host.json */
export type HostConfig = {
  machine: string;
  workers?: { relay?: { url: string; key?: string } };
  /** разделы модулей: host.config() */
  modules?: Record<string, unknown>;
};

/** То, что ядро берёт от Agent SDK. На стенде — подделка. */
export type SdkApi = {
  query: (p: { prompt: AsyncIterable<SDKUserMessage>; options?: Options }) => Query;
  /** функции SDK сессии: getSessionMessages, renameSession… */
  functions: Record<string, (...a: any[]) => Promise<unknown>>;
  /** команда claude той же версии */
  cli: (args: string[], env: Record<string, string | undefined>, input?: string) => Promise<{ code: number | null; out: string }>;
};

export type Deps = {
  /** ~/.switchboard */
  home: string;
  config: HostConfig;
  /** module.json ядра */
  core: Manifest;
  release: Release;
  sdk: SdkApi;
  keeper: KeeperAddr;
  /** ключ машины для relay */
  relayKey?: string;
  WebSocket?: WsCtor;
  clock?: Clock;
  loadRelease?: (dir: string) => Promise<Release>;
  /** выход процесса Host после штатной остановки */
  exit?: (code: number) => void;
  /** период ping и первая пауза переподключения link */
  pingMs?: number;
  pauseMs?: number;
};

/** Host не стартует: причины — строками гейта. */
export class StartError extends Error {
  readonly reasons: string[];
  constructor(reasons: string[]) {
    super(reasons.join("\n"));
    this.reasons = reasons;
  }
}

export const MODULE_ERROR = "module_error";
const HANDLED = Symbol("handled");
const SKIP = Symbol("skip");

/** Нарушение договора уже выключило модуль: отказ не должен ронять Host, даже если модуль его не ждёт. */
export function handled<T>(p: Promise<T>): Promise<T> {
  p.catch(() => {});
  return p;
}

/** Загруженная версия модуля. */
export class Mod {
  readonly name: string;
  readonly manifest: Manifest;
  readonly module: Module;
  /** порядковый номер загрузки: модуль, загруженный после старта процесса сессии, видит её как attach */
  readonly seq: number;
  /** причина выключения на всей машине */
  down: string | null = null;
  constructor(m: Manifest, mod: Module, seq: number) {
    this.name = m.name;
    this.manifest = m;
    this.module = mod ?? {};
    this.seq = seq;
  }
}

type Pending = { mod: string; gen: number; run: () => void };

export class Kernel {
  readonly deps: Deps;
  readonly machine: string;
  readonly clock: Clock;
  readonly stores: Stores;
  readonly journal: Journal;
  readonly keeper: KeeperClient;
  readonly als = new AsyncLocalStorage<{ mod: string; sess: Sess | null }>();
  readonly sessions = new Map<string, Sess>();
  readonly abort = new AbortController();
  release: Release;
  mods: Mod[] = [];
  byName = new Map<string, Mod>();
  reqOwner = new Map<string, Mod>();
  frameOwner = new Map<string, Mod>();
  decideOwner = new Map<string, string>();
  elicitOwner: string | null = null;
  /** окно перезагрузки: вызовы модуля ждут здесь и идут новой версии по порядку */
  reloading = new Map<string, Promise<void>>();
  relay: Link | null = null;
  seq = 0;
  shutting: Promise<void> | null = null;
  private inflight = new Set<Promise<unknown>>();
  private probes = new Set<Query>();
  private hostFacades = new Map<Mod, Host>();
  private reloadChain: Promise<unknown> = Promise.resolve();
  private reqSeq = 0;
  private readonly idPrefix = randomUUID().slice(0, 8);

  constructor(deps: Deps) {
    this.deps = deps;
    this.machine = deps.config.machine;
    this.clock = deps.clock ?? realClock;
    this.release = deps.release;
    this.stores = new Stores(join(deps.home, "store"));
    this.journal = journal(join(deps.home, "journal"), this.machine, this.clock);
    this.keeper = new KeeperClient(deps.keeper, {
      exited: (e) => this.onExited(e),
      stop: (reason) => void this.shutdown(reason),
    });
  }

  get version(): string {
    return this.release.version;
  }
  get sdkVersion(): string {
    return this.release.sdk;
  }

  log(who: string, rec: LogRecord): void {
    this.journal(who, rec);
  }

  // ───────────── старт ─────────────

  /** Старт Host по шагам дизайна. Гейт не прошёл — StartError, сессии у keeper не тронуты. */
  async start(): Promise<void> {
    const relayOn = !!this.deps.config.workers?.relay;
    const errors = gate(this.deps.core, this.release.modules, relayOn);
    if (errors.length) {
      for (const e of errors) this.log("core", { kind: "stop", ev: "gate", word: "check_failed", why: e });
      throw new StartError(errors);
    }
    this.mods = this.release.modules.map((e) => new Mod(e.manifest, e.module, ++this.seq));
    this.index();
    this.log("core", { ev: "host_start", version: this.version, sdk: this.sdkVersion, modules: this.mods.map((m) => `${m.name} ${m.manifest.version}`) });
    for (const m of this.mods) await this.startModule(m);

    await this.keeper.connect();
    const procs = await this.keeper.list();
    for (const rec of this.stores.core()) this.sessions.set(rec.callsign, new Sess(this, rec));
    const alive = new Set(procs.map((p) => p.id));
    for (const p of procs) {
      if (this.sessions.has(p.id)) continue;
      this.log("core", { kind: "stop", ev: "orphan_kill", callsign: p.id, why: `процесс ${p.id} (pid ${p.pid}) не в списке сессий — kill` });
      await this.keeper.kill(p.id, true);
    }
    // вклады всех сессий — до запуска: два владельца у имени — Host не стартует
    const parts = new Map<Sess, ReturnType<Sess["collectParts"]>>();
    const conflicts: string[] = [];
    for (const s of this.sessions.values()) {
      if (s.rec.stopped) continue;
      try {
        parts.set(s, s.collectParts());
      } catch (e) {
        conflicts.push((e as Error).message);
      }
    }
    if (conflicts.length) {
      for (const e of conflicts) this.log("core", { kind: "stop", ev: "gate", word: "check_failed", why: e });
      this.keeper.close();
      throw new StartError(conflicts);
    }
    for (const s of this.sessions.values()) {
      if (s.rec.stopped) s.state = "stopped";
      else void s.launch(alive.has(s.callsign) ? "attach" : "resume", { parts: parts.get(s) }).catch(() => {});
    }
    this.connectRelay();
    await Promise.all([...this.sessions.values()].map((s) => s.settled()));
    if (this.shutting) return;
    const r = await this.keeper.send({ op: "ready", version: this.version });
    this.log("core", { ev: "ready", version: this.version, ...(r.ok ? {} : { word: r.error }) });
  }

  private async startModule(m: Mod): Promise<boolean> {
    if (!m.module.start) return true;
    let okStart = true;
    await this.invoke(m.name, "start", null, (x) => x.start!(this.hostFacade(m)), () => {
      okStart = false;
    });
    return okStart;
  }

  /** Владельцы имён по загруженным модулям. */
  private index(): void {
    this.byName = new Map(this.mods.map((m) => [m.name, m]));
    this.reqOwner.clear();
    this.frameOwner.clear();
    this.decideOwner.clear();
    this.elicitOwner = null;
    for (const m of this.mods) {
      for (const n of Object.keys(m.module.requests ?? {})) this.reqOwner.set(n, m);
      for (const n of Object.keys(m.module.frames ?? {})) this.frameOwner.set(n, m);
      for (const t of Object.keys(m.module.decide ?? {})) this.decideOwner.set(t, m.name);
      if (m.module.elicit) this.elicitOwner = m.name;
    }
  }

  /** contract в hello: provides всех модулей списка. */
  contract(): Record<string, number> {
    const c: Record<string, number> = {};
    for (const m of this.mods) Object.assign(c, m.manifest.provides ?? {});
    return c;
  }

  saveCore(): void {
    const list: CoreRecord[] = [...this.sessions.values()].map((s) => s.rec);
    this.stores.saveCore(list);
  }

  // ───────────── ловушка ошибок модуля ─────────────

  isDown(m: Mod, s: Sess | null): boolean {
    return !!m.down || (!!s && s.failed.has(m.name));
  }

  /**
   * Вызов модуля. Ошибка не идёт дальше: модуль выключается в сессии s (или на машине), onFail даёт замену.
   * Refusal — отказ словом, его ловит вызывающий. Во время перезагрузки модуля вызов ждёт и идёт новой версии.
   */
  invoke<T>(name: string, where: string, s: Sess | null, fn: (m: Module, mod: Mod) => T | Promise<T>, onFail: (e: unknown) => T): T | Promise<T> {
    const wait = this.reloading.get(name);
    return wait ? wait.then(() => this.call(name, where, s, fn, onFail)) : this.call(name, where, s, fn, onFail);
  }

  /** Вызов модуля в ловушке мимо окна перезагрузки — его зовёт сама перезагрузка. */
  call<T>(name: string, where: string, s: Sess | null, fn: (m: Module, mod: Mod) => T | Promise<T>, onFail: (e: unknown) => T): T | Promise<T> {
    {
      const cur = this.byName.get(name);
      if (!cur) return onFail(new Error(`${name} снят`));
      if (this.isDown(cur, s)) return onFail(new Error(MODULE_ERROR));
      const failed = (e: unknown): T => {
        if (e instanceof Refusal) throw e;
        this.disable(cur, s, where, e);
        return onFail(e);
      };
      try {
        const r = this.als.run({ mod: name, sess: s }, () => fn(cur.module, cur));
        if (r && typeof (r as Promise<T>).then === "function") return (r as Promise<T>).then(undefined, failed);
        return r;
      } catch (e) {
        return failed(e);
      }
    }
  }

  /** Выключить модуль в сессии или на машине: failed в roster, строка stop в журнале. */
  disable(m: Mod, s: Sess | null, where: string, e: unknown): void {
    if (e && typeof e === "object" && (e as Record<symbol, unknown>)[HANDLED]) return;
    const msg = e instanceof Error ? e.message : String(e);
    const short = `${msg} · ${where}`;
    if (s) {
      if (s.failed.has(m.name)) return;
      s.failed.set(m.name, short);
    } else {
      if (m.down) return;
      m.down = short;
    }
    const stack = e instanceof Error && e.stack ? e.stack : msg;
    this.log("core", {
      kind: "stop",
      ev: "module_failed",
      word: MODULE_ERROR,
      module: m.name,
      ...(s ? { callsign: s.callsign } : {}),
      why: `${m.name}: ${where} — ${stack}; модуль выключен ${s ? "в сессии" : "на машине"}`,
    });
    for (const x of s ? [s] : this.sessions.values()) x.push();
  }

  /** Нарушение договора: модуль выключен там, откуда звал, и получает исключение. */
  violation(m: Mod, s: Sess | null, reason: string): never {
    const e = new Error(reason);
    this.disable(m, s, "договор", e);
    (e as unknown as Record<symbol, boolean>)[HANDLED] = true;
    throw e;
  }

  /** Сессия, из вызова которой модуль m зовёт ядро сейчас. */
  callerSession(m: Mod): Sess | null {
    const c = this.als.getStore();
    return c && c.mod === m.name ? c.sess : null;
  }

  // ───────────── вклады в query() ─────────────

  canUseTool(s: Sess, tool: string, input: Record<string, unknown>, o: Record<string, unknown>) {
    const owner = this.decideOwner.get(tool);
    if (!owner) {
      if (tool === "AskUserQuestion") {
        this.log("core", { kind: "refuse", ev: "decide", word: "unknown_request", callsign: s.callsign, why: "AskUserQuestion: у решения нет владельца — ответ за человека не выбран" });
        return Promise.resolve({ behavior: "deny" as const, message: "unknown_request" });
      }
      this.log("core", { ev: "allow", callsign: s.callsign, tool, why: "владельца решения нет — режим «разрешено всё»" });
      return Promise.resolve({ behavior: "allow" as const, updatedInput: input });
    }
    const deny = (): PermissionResult => {
      this.log("core", { kind: "refuse", ev: "decide", word: MODULE_ERROR, callsign: s.callsign, module: owner, tool });
      return { behavior: "deny" as const, message: MODULE_ERROR };
    };
    return this.pending<PermissionResult>(s, owner, (m, mod) => {
      const d = m.decide?.[tool];
      if (!d) throw new Error(`decide.${tool} нет в новой версии`);
      return d(s.facade(mod), input, o as never);
    }, `decide.${tool}`, deny);
  }

  elicit(s: Sess, req: unknown, o: { signal: AbortSignal; requestId: string }) {
    const owner = this.elicitOwner;
    const decline: ElicitationResult = { action: "decline" };
    if (!owner) {
      this.log("core", { ev: "elicit", callsign: s.callsign, why: "у форм MCP нет владельца — decline" });
      return Promise.resolve(decline);
    }
    return this.pending<ElicitationResult>(s, owner, (m, mod) => {
      if (!m.elicit) throw new Error("elicit нет в новой версии");
      return m.elicit(s.facade(mod), req as never, o);
    }, "elicit", () => decline);
  }

  /** Вызов, ждущий человека: при перезагрузке модуля ядро отдаёт его новой версии заново. */
  private pending<T>(s: Sess, owner: string, fn: (m: Module, mod: Mod) => T | Promise<T>, where: string, onFail: () => T): Promise<T> {
    return new Promise<T>((resolve) => {
      const p: Pending = { mod: owner, gen: 0, run: () => {} };
      p.run = () => {
        const g = ++p.gen;
        const done = (r: T) => {
          if (p.gen !== g) return;
          s.pending.delete(p);
          resolve(r);
        };
        Promise.resolve(this.invoke(owner, where, s, fn, onFail)).then(done, () => done(onFail()));
      };
      s.pending.add(p);
      p.run();
    });
  }

  // ───────────── keeper ─────────────

  private onExited(e: Exited): void {
    this.sessions.get(e.id)?.onExited(e);
  }

  // ───────────── relay ─────────────

  private connectRelay(): void {
    const r = this.deps.config.workers?.relay;
    if (!r || this.shutting) return;
    this.relay = link({
      url: r.url,
      key: this.deps.relayKey ?? "",
      hello: () => ({
        sdk: this.sdkVersion,
        contract: this.contract(),
        sessions: [...this.sessions.values()].map((s) => s.helloRecord()),
      }),
      onFrame: (f) => this.onFrame(f),
      onState: (st, why) => this.onRelayState(st, why),
      WebSocket: this.deps.WebSocket,
      pingMs: this.deps.pingMs,
      pauseMs: this.deps.pauseMs,
    });
  }

  private onRelayState(st: LinkState, why?: string): void {
    if (st === "stopped") {
      if (why === "rehello" || why === "shutting_down") return;
      this.log("core", { kind: "stop", ev: "relay_stopped", word: why, why: `relay закрыл соединение: ${why} — Host не переподключается` });
    } else if (st === "closed") this.log("core", { ev: "relay_closed", why: why ?? "" });
    else if (st === "open") this.log("core", { ev: "hello", why: "hello принят" });
  }

  /** Новый hello: provides поменялись. Ждущие ответа этой машины запросы — disconnected. */
  private rehello(): void {
    const old = this.relay;
    if (!old) return;
    this.relay = null;
    old.close(1000, "rehello");
    this.connectRelay();
  }

  send(f: Frame): boolean {
    return this.relay?.send(f) ?? false;
  }

  private reply(f: Frame, r: Reply): void {
    this.send(f.from ? { ...r, to: f.from } : r);
  }

  /** Кадр из relay: запрос — владельцу по type; кадр — владельцу или в on.frame тем, у кого имя в uses. */
  private onFrame(f: Frame): void {
    if (isReply(f)) return; // ответ без ждущего: link свои уже разобрал
    if (typeof f.id === "string") {
      const p = this.handleRequest(f as Frame & { id: string }).then((r) => this.reply(f, r));
      this.inflight.add(p);
      void p.finally(() => this.inflight.delete(p));
      return;
    }
    const owner = this.frameOwner.get(f.type);
    if (owner) {
      if (this.shutting) return;
      const s = this.frameSession(f);
      void this.invoke(owner.name, `frames.${f.type}`, s, (m, mod) => m.frames![f.type](f, this.ctx(mod, f.from)), () => undefined);
      return;
    }
    let got = false;
    for (const m of this.mods) {
      if (!m.module.on?.frame || !Object.keys(m.manifest.uses ?? {}).some((r) => nameOf(r) === f.type)) continue;
      got = true;
      void this.invoke(m.name, "on.frame", null, (x) => x.on!.frame!(f), () => undefined);
    }
    if (!got) this.log("core", { kind: "refuse", ev: "frame", word: "unknown_request", why: `кадр ${f.type}: владельца нет` });
  }

  private frameSession(f: Frame): Sess | null {
    if (typeof f.callsign === "string") return this.sessions.get(f.callsign) ?? null;
    if (typeof f.to === "string") return this.sessions.get(f.to) ?? null;
    return null;
  }

  private ctx(m: Mod, from?: string) {
    return { host: this.hostFacade(m), from, signal: this.abort.signal };
  }

  /** Запрос владельцу: проверки ядра, вызов в ловушке, reply. */
  async handleRequest(f: Frame & { id: string }, from?: string): Promise<Reply> {
    if (this.shutting) {
      this.log("core", { kind: "refuse", ev: "request", word: "shutting_down", id: f.id, type: f.type, from: f.from });
      return fail(f.id, "shutting_down");
    }
    const owner = this.reqOwner.get(f.type);
    if (!owner) {
      this.log("core", { kind: "refuse", ev: "request", word: "unknown_request", id: f.id, from: f.from, why: `${f.type}: владельца нет` });
      return fail(f.id, "unknown_request");
    }
    const v = owner.manifest.provides[f.type];
    if (f.v !== v) {
      this.log("core", {
        kind: "refuse",
        ev: "request",
        word: "contract_mismatch",
        id: f.id,
        from: f.from,
        why: `${f.type} — запрошена v${f.v ?? "—"}, у ${owner.name} v${v}`,
      });
      return fail(f.id, "contract_mismatch");
    }
    let s: Sess | null = null;
    if (typeof f.callsign === "string") {
      s = this.sessions.get(f.callsign) ?? null;
      if (!s) {
        this.log("core", { kind: "refuse", ev: "request", word: "offline", id: f.id, from: f.from, why: `${f.type}: сессии ${f.callsign} нет на машине` });
        return fail(f.id, "offline");
      }
    }
    try {
      const r = await this.invoke(owner.name, `requests.${f.type}`, s, (m, mod) => m.requests![f.type](f, this.ctx(mod, from ?? f.from)), () => SKIP);
      if (r === SKIP) {
        this.log("core", { kind: "refuse", ev: "request", word: MODULE_ERROR, id: f.id, from: f.from, module: owner.name, why: `${f.type}: модуль ${owner.name} выключен${s ? " в " + s.callsign : ""}` });
        return fail(f.id, MODULE_ERROR);
      }
      return ok(f.id, r);
    } catch (e) {
      const word = (e as Refusal).word;
      this.log(owner.name, { kind: "refuse", ev: "request", word, id: f.id, from: f.from, why: (e as Refusal).why ?? `${f.type}: ${word}` });
      return fail(f.id, word);
    }
  }

  // ───────────── что ядро даёт модулю ─────────────

  hostFacade(m: Mod): Host {
    let h = this.hostFacades.get(m);
    if (h) return h;
    const k = this;
    h = {
      get machine() {
        return k.machine;
      },
      get version() {
        return k.version;
      },
      get sdk() {
        return k.sdkVersion;
      },
      session: (callsign) => k.sessions.get(callsign)?.facade(m),
      sessions: () => [...k.sessions.values()].map((s) => ({ callsign: s.callsign, cwd: s.rec.cwd, state: s.state })),
      open: async (spec) => (await k.open(spec)).facade(m),
      request: (name, payload) => handled(k.request(m, name, payload)),
      emit: (frame) => k.emit(m, frame),
      store: <T>() => k.stores.machine<T>(m.name) as Store<T>,
      config: <T>() => (k.deps.config.modules?.[m.name] ?? {}) as T,
      log: (rec) => k.log(m.name, rec),
      probe: (o) => k.probe(m, o?.env),
      cli: (args, o) => k.deps.sdk.cli(args, { ...process.env, ...(o?.env ?? {}), DISABLE_UPDATES: "1" }, o?.input),
      reload: (dir) => k.reload(dir),
    };
    this.hostFacades.set(m, h);
    return h;
  }

  /** host.request: имя из uses или своё; владелец — модуль этой машины, keeper или relay. */
  async request(m: Mod, name: string, payload: Record<string, unknown>): Promise<Result> {
    const caller = this.callerSession(m);
    const own = m.manifest.provides?.[name] !== undefined;
    const ref = Object.keys(m.manifest.uses ?? {}).find((r) => nameOf(r) === name);
    if (!own && !ref) this.violation(m, caller, `${name} нет в uses`);
    const owner = own ? m.name : ownerOf(ref!);
    const address = (payload.callsign ?? payload.machine ?? payload.to) as unknown;
    const target = typeof payload.machine === "string" ? payload.machine : typeof address === "string" ? machineOf(address) : null;

    if (owner === "keeper") {
      const { v: _v, ...rest } = payload;
      const r = await this.keeper.send({ op: name, ...rest });
      return r.ok ? { ok: true, result: r.result } : { ok: false, error: r.error ?? "keeper" };
    }
    const local = this.byName.has(owner) && (target === null || target === this.machine) && !(payload.to && typeof payload.to !== "string");
    if (local) {
      const id = `${this.idPrefix}-${++this.reqSeq}`;
      const r = await this.handleRequest({ ...payload, type: name, id } as Frame & { id: string }, `@${this.machine}`);
      return r.ok ? { ok: true, result: r.result } : { ok: false, error: r.error };
    }
    if (!this.relay) return { ok: false, error: "disconnected" };
    const frame: Frame = { ...payload, type: name };
    if (!this.byName.has(owner) && payload.to === undefined && payload.callsign === undefined && payload.machine === undefined) frame.to = owner;
    const r = await this.relay.request(frame);
    return r.ok ? { ok: true, result: r.result } : { ok: false, error: r.error };
  }

  /** host.emit: кадр без ответа; type — свой или из uses. Связи нет — disconnected, очереди нет. */
  emit(m: Mod, f: Frame): Result {
    const known = m.manifest.provides?.[f.type] !== undefined || Object.keys(m.manifest.uses ?? {}).some((r) => nameOf(r) === f.type);
    if (!known) this.violation(m, this.callerSession(m), `${f.type} нет в provides и uses`);
    return this.send(f) ? { ok: true } : { ok: false, error: "disconnected" };
  }

  private probe(m: Mod, env?: Record<string, string>): Probe {
    const q = this.deps.sdk.query({
      prompt: new InputQueue().stream(),
      options: {
        env: { ...process.env, ...(env ?? {}), DISABLE_UPDATES: "1" },
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
      },
    });
    this.probes.add(q);
    return {
      sdk: (name, ...args) => handled((async () => {
        if (!(m.manifest.calls ?? []).includes(name)) this.violation(m, this.callerSession(m), `${name} нет в calls`);
        return (q as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[name](...args);
      })()),
      close: () => {
        this.probes.delete(q);
        q.close();
      },
    };
  }

  /** s.sdk: метод query() или функция SDK сессии — только имя из calls модуля. */
  async sessionSdk(m: Mod, s: Sess, name: string, args: unknown[]): Promise<unknown> {
    if (!(m.manifest.calls ?? []).includes(name)) this.violation(m, s, `${name} нет в calls`);
    const at = SESSION_FUNCTIONS[name];
    if (at !== undefined) {
      const a: unknown[] = [s.rec.session_id, ...args];
      a[at] = { dir: s.rec.cwd, ...((a[at] as object) ?? {}) };
      return this.deps.sdk.functions[name](...a);
    }
    if (!s.q) throw new Error(`${s.callsign}: процесс сессии не запущен`);
    return (s.q as unknown as Record<string, (...x: unknown[]) => Promise<unknown>>)[name](...args);
  }

  /** host.open: новая сессия в списке ядра; ответ — после initialize. */
  async open(spec: OpenSpec): Promise<Sess> {
    if (this.shutting) throw new Error("shutting_down");
    if (machineOf(spec.callsign) !== this.machine) throw new Error(`${spec.callsign}: callsign не этой машины`);
    if (this.sessions.has(spec.callsign)) throw new Error(`${spec.callsign}: имя занято`);
    const fresh = randomUUID();
    const rec: CoreRecord = {
      callsign: spec.callsign,
      cwd: spec.cwd,
      session_id: spec.resume && !spec.fork ? spec.resume : fresh,
      sdk: this.sdkVersion,
      stopped: false,
    };
    const s = new Sess(this, rec);
    let parts;
    try {
      parts = s.collectParts();
    } catch (e) {
      this.log("core", { kind: "stop", ev: "open", callsign: spec.callsign, why: (e as Error).message });
      throw e;
    }
    this.sessions.set(rec.callsign, s);
    this.saveCore();
    this.log("core", { ev: "open", callsign: rec.callsign, cwd: rec.cwd });
    const kind = spec.point !== undefined ? "point" : spec.resume ? "resume" : "spawn";
    s.point = spec.point;
    await s.launch(kind, { parts, first: spec.resume ? { resume: spec.resume, fork: spec.fork } : { fresh: true } });
    return s;
  }

  // ───────────── перезагрузка модулей ─────────────

  reload(dir: string): Promise<ReloadResult> {
    const p = this.reloadChain.then(() => this.doReload(dir));
    this.reloadChain = p.catch(() => {});
    return p;
  }

  private async doReload(dir: string): Promise<ReloadResult> {
    const load = this.deps.loadRelease;
    let rel: Release;
    try {
      if (!load) throw new Error("загрузчик выпусков не задан");
      rel = await load(dir);
    } catch (e) {
      const why = `${dir}: ${(e as Error).message}`;
      this.log("core", { kind: "refuse", ev: "reload", word: "check_failed", why });
      return { ok: false, error: "check_failed", why };
    }
    if (rel.core !== this.release.core || rel.sdk !== this.release.sdk) {
      const why = `ядро ${this.release.core} → ${rel.core}, SDK ${this.release.sdk} → ${rel.sdk}`;
      this.log("core", { kind: "refuse", ev: "reload", word: "core_changed", why: `${rel.version}: ${why} — нужен новый Host через keeper` });
      return { ok: false, error: "core_changed", why };
    }
    const errors = gate(this.deps.core, rel.modules, !!this.deps.config.workers?.relay);
    if (errors.length) {
      const why = errors.join("; ");
      this.log("core", { kind: "refuse", ev: "reload", word: "check_failed", why: `${rel.version}: ${why}` });
      return { ok: false, error: "check_failed", why };
    }
    const from = this.version;
    const old = new Map(this.mods.map((m) => [m.name, m]));
    const next = new Map(rel.modules.map((e) => [e.manifest.name, e]));
    const changed = new Set<string>();
    for (const [n, m] of old) if (next.get(n)?.manifest.version !== m.manifest.version) changed.add(n);
    for (const n of next.keys()) if (!old.has(n)) changed.add(n);
    const modules: Record<string, [string | null, string | null]> = {};
    for (const n of changed) modules[n] = [old.get(n)?.manifest.version ?? null, next.get(n)?.manifest.version ?? null];
    const provBefore = JSON.stringify(this.contract());

    // окно: вызовы перезагружаемых модулей ждут в ядре
    let open!: () => void;
    const window = new Promise<void>((r) => (open = r));
    for (const n of changed) this.reloading.set(n, window);
    // прежние версии — штатная остановка, в обратном порядке списка
    for (const m of [...this.mods].reverse()) {
      if (!changed.has(m.name) || !m.module.stop) continue;
      await this.callDirect(m, "stop", () => m.module.stop!());
    }
    this.mods = rel.modules.map((e) => (changed.has(e.manifest.name) ? new Mod(e.manifest, e.module, ++this.seq) : old.get(e.manifest.name)!));
    this.byName = new Map(this.mods.map((m) => [m.name, m]));
    for (const s of this.sessions.values()) for (const n of changed) s.failed.delete(n);
    this.index();
    this.release = { ...rel, dir: this.release.dir };
    // новые версии поднимают своё из того же хранилища, по порядку списка
    const failedStart: string[] = [];
    for (const m of this.mods) {
      if (!changed.has(m.name) || !m.module.start) continue;
      const okStart = await this.callDirect(m, "start", () => m.module.start!(this.hostFacade(m)));
      if (!okStart) failedStart.push(m.name);
    }
    // вклады — в живые сессии
    const later: string[] = [];
    for (const s of this.sessions.values()) {
      if (!s.q) continue;
      const rest = await s.applyParts(changed);
      if (rest.length) {
        later.push(s.callsign);
        this.log("core", { ev: "reload_later", callsign: s.callsign, why: `${rest.join(", ")} — со следующего старта ${s.callsign}` });
      }
    }
    // новые версии видят живые сессии как после перезапуска Host: start, затем on.open
    for (const m of this.mods) {
      if (!changed.has(m.name) || !m.module.on?.open) continue;
      for (const s of this.sessions.values()) if (s.q && s.ready) this.call(m.name, "on.open", s, (x, mod) => x.on!.open!(s.facade(mod)), () => undefined);
    }
    // окно закрыто: ждавшие вызовы идут новой версии по порядку
    for (const n of changed) this.reloading.delete(n);
    open();
    // ждущие человека decide и elicit прежней версии — новой заново, с тем же toolUseID
    for (const s of this.sessions.values()) for (const p of [...s.pending]) if (changed.has(p.mod)) p.run();
    if (JSON.stringify(this.contract()) !== provBefore) this.rehello();
    // ждавшие вызовы уже у новой версии — поля с их следами
    await new Promise((r) => setImmediate(r));
    for (const s of this.sessions.values()) s.push();

    if (failedStart.length) {
      const why = failedStart.map((n) => `${n}: ${this.byName.get(n)?.down}`).join("; ");
      this.log("core", { kind: "stop", ev: "reload", word: MODULE_ERROR, why: `${rel.version}: ${why}; ready не послан` });
      return { ok: false, error: "module_error", why };
    }
    const r = await this.keeper.send({ op: "ready", version: rel.version });
    this.log("core", { ev: "reload", from, to: rel.version, modules, later, ...(r.ok ? {} : { word: r.error }) });
    return { ok: true, result: { from, to: rel.version, modules, later } };
  }

  /** start()/stop() версии модуля мимо окна перезагрузки — сама перезагрузка их и зовёт. */
  private async callDirect(m: Mod, where: "start" | "stop", fn: () => unknown): Promise<boolean> {
    try {
      await this.als.run({ mod: m.name, sess: null }, fn);
      return true;
    } catch (e) {
      this.disable(m, null, where, e);
      return false;
    }
  }

  // ───────────── штатная остановка ─────────────

  /**
   * upgrade: новые запросы — shutting_down, начатые доводятся, stop() модулей, процессы claude живут у keeper.
   * machine: то же, но сначала каждая сессия — interrupt → result → close().
   */
  shutdown(reason: string): Promise<void> {
    if (this.shutting) return this.shutting;
    this.shutting = (async () => {
      this.log("core", { ev: "shutdown", why: `остановка: ${reason}` });
      this.abort.abort();
      await Promise.allSettled([...this.inflight]);
      if (reason === "machine") await Promise.all([...this.sessions.values()].map((s) => s.shutdown(true)));
      else for (const s of this.sessions.values()) void s.shutdown(false);
      for (const m of [...this.mods].reverse()) {
        if (!m.module.stop || m.down) continue;
        await this.callDirect(m, "stop", () => m.module.stop!());
      }
      for (const q of this.probes) q.close();
      this.relay?.close(1000, "shutting_down");
      this.keeper.close();
      this.log("core", { ev: "exit", why: `выход 0 · ${reason}` });
      this.deps.exit?.(0);
    })();
    return this.shutting;
  }
}

export type { Session };
