// Ядро Host: модули, сессии, держатели процессов claude, связь с relay, реестр владельцев, ловушка ошибок,
// штатная остановка. Само ничего не решает: находит владельца и передаёт ему.
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { ElicitationResult, Options, PermissionResult, Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { accepts, fail, hostOf, isReply, kindOf, machineOf, ok, serviceAddress } from "@switchboard/protocol";
import type { Frame, Reply } from "@switchboard/protocol";
import { fleet } from "@switchboard/relay";
import type { FleetClient, LinkState, Roster, WsCtor } from "@switchboard/relay";
import { isRefusal, refuse } from "./refusal.ts";
import type {
  Host,
  LogRecord,
  Manifest,
  Module,
  OpenSpec,
  Probe,
  Result,
  Session,
  Store,
} from "../contract.ts";
import { SESSION_FUNCTIONS } from "./calls.ts";
import type { Clock } from "./clock.ts";
import { realClock } from "./clock.ts";
import { journal } from "./journal.ts";
import type { Journal } from "./journal.ts";
import { HolderClient } from "./holders.ts";
import type { Exited, HolderApi } from "./holders.ts";
import { InputQueue } from "./queue.ts";
import { gate, nameOf, ownerOf } from "./registry.ts";
import type { Release } from "./release.ts";
import { Sess } from "./session.ts";
import { Stores } from "./store.ts";
import type { CoreRecord } from "./store.ts";

/** Конфиг Host: машина, relay и Worker'ы флота — из окружения keeper, разделы модулей — ~/.switchboard/host.json */
export type HostConfig = {
  machine: string;
  /** адрес relay wss://…: объект своей машины — /m/<машина>, других — гостем */
  relay?: string;
  /** Worker'ы флота: имя → адрес https; gate — список машин, остальные — POST кадров к ним */
  workers?: Record<string, string>;
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
  /** путь к исполняемому claude из пакета SDK: его же получает query() сессии — SDK не ищет его второй раз */
  bin?: string;
};

export type Deps = {
  /** ~/.switchboard */
  home: string;
  config: HostConfig;
  /** module.json ядра */
  core: Manifest;
  release: Release;
  sdk: SdkApi;
  /** держатели процессов claude: файл keeper в режиме hold */
  holders: HolderApi;
  /** пропуск машины: им Host входит в relay и зовёт Worker'ов */
  relayKey?: string;
  WebSocket?: WsCtor;
  /** POST к Worker'ам; по умолчанию глобальный fetch */
  fetch?: typeof fetch;
  clock?: Clock;
  /** выход процесса Host после штатной остановки */
  exit?: (code: number) => void;
  /** период ping и первая пауза переподключения link */
  pingMs?: number;
  pauseMs?: number;
  /** предел штатной остановки, мс: не успела — журнал и жёсткий выход 1. По умолчанию 30 000; keeper ждёт дольше. */
  stopMs?: number;
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
/** Предел start() и session() модуля на старте: вдвое выше самого долгого старта Host (host_start → ready до 5,9 с). */
export const START_MS = 12_000;
/** Предел ответа процесса claude на initialize — тот же, что у startup() SDK (initializeTimeoutMs по умолчанию 60 с). */
export const INIT_MS = 60_000;
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
  /** причина выключения на всей машине */
  down: string | null = null;
  constructor(m: Manifest, mod: Module) {
    this.name = m.name;
    this.manifest = m;
    this.module = mod ?? {};
  }
}

export class Kernel {
  readonly deps: Deps;
  readonly machine: string;
  readonly clock: Clock;
  readonly stores: Stores;
  readonly journal: Journal;
  readonly holders: HolderClient;
  readonly als = new AsyncLocalStorage<{ mod: string; sess: Sess | null }>();
  readonly sessions = new Map<string, Sess>();
  readonly abort = new AbortController();
  release: Release;
  mods: Mod[] = [];
  byName = new Map<string, Mod>();
  reqOwner = new Map<string, Mod>();
  /** последний roster от relay — модули берут его через host.roster() */
  private lastRoster: Roster | null = null;
  frameOwner = new Map<string, Mod>();
  decideOwner = new Map<string, string>();
  elicitOwner: string | null = null;
  relay: FleetClient | null = null;
  shutting: Promise<void> | null = null;
  private inflight = new Set<Promise<unknown>>();
  private probes = new Set<Query>();
  private hostFacades = new Map<Mod, Host>();
  private reqSeq = 0;
  private readonly idPrefix = randomUUID().slice(0, 8);

  constructor(deps: Deps) {
    this.deps = deps;
    this.machine = deps.config.machine;
    this.clock = deps.clock ?? realClock;
    this.release = deps.release;
    this.stores = new Stores(join(deps.home, "store"));
    this.journal = journal(join(deps.home, "journal"), this.machine, this.clock);
    this.holders = new HolderClient(deps.holders, { exited: (e) => this.onExited(e) });
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

  /** Старт Host по шагам дизайна. Гейт не прошёл — StartError, сессии у держателей не тронуты. */
  async start(): Promise<void> {
    const relayOn = !!this.deps.config.relay;
    const errors = gate(this.deps.core, this.release.modules, relayOn);
    if (errors.length) {
      for (const e of errors) this.log("core", { kind: "stop", ev: "gate", word: "check_failed", why: e });
      throw new StartError(errors);
    }
    this.mods = this.release.modules.map((e) => new Mod(e.manifest, e.module));
    this.index();
    this.log("core", { ev: "host_start", version: this.version, sdk: this.sdkVersion, modules: this.mods.map((m) => `${m.name} ${m.manifest.version}`) });
    for (const m of this.mods) await this.startModule(m);

    const procs = this.holders.list();
    for (const rec of this.stores.core()) this.sessions.set(rec.callsign, new Sess(this, rec));
    const alive = new Set(procs.map((p) => p.id));
    for (const p of procs) {
      if (this.sessions.has(p.id)) continue;
      this.log("core", { kind: "stop", ev: "orphan_kill", callsign: p.id, why: `процесс ${p.id} (pid ${p.pid}) не в списке сессий — kill` });
      await this.holders.kill(p.id);
    }
    // вклады всех сессий — до запуска: два владельца у имени — Host не стартует
    const parts = new Map<Sess, Awaited<ReturnType<Sess["collectParts"]>>>();
    const conflicts: string[] = [];
    for (const s of this.sessions.values()) {
      if (s.rec.stopped) continue;
      s.prepare(alive.has(s.callsign) ? "attach" : "resume");
      try {
        parts.set(s, await s.collectParts());
      } catch (e) {
        conflicts.push((e as Error).message);
      }
    }
    if (conflicts.length) {
      for (const e of conflicts) this.log("core", { kind: "stop", ev: "gate", word: "check_failed", why: e });
      this.holders.close();
      throw new StartError(conflicts);
    }
    for (const s of this.sessions.values()) {
      if (s.rec.stopped) s.state = "stopped";
      else void s.launch(alive.has(s.callsign) ? "attach" : "resume", { parts: parts.get(s) }).catch(() => {});
    }
    this.connectRelay();
    await Promise.all([...this.sessions.values()].map((s) => s.settled()));
    if (this.shutting) return;
    this.log("core", { ev: "ready", version: this.version });
    for (const m of this.mods) {
      if (m.module.on?.ready) this.call(m.name, "on.ready", null, (x) => x.on!.ready!(), () => undefined);
    }
  }

  private async startModule(m: Mod): Promise<boolean> {
    if (!m.module.start) return true;
    let okStart = true;
    await this.call(m.name, "start", null, (x) => this.within(x.start!(this.hostFacade(m)), `start() не вернулся за ${START_MS / 1000} с`), () => {
      okStart = false;
    });
    return okStart;
  }

  /** Значение или исключение со словами why за предел START_MS по часам ядра: ловушка call выключает модуль. */
  within<T>(r: T | Promise<T>, why: string): T | Promise<T> {
    if (!r || typeof (r as Promise<T>).then !== "function") return r;
    let t: unknown;
    const late = new Promise<never>((_ok, no) => (t = this.clock.setTimeout(() => no(new Error(why)), START_MS)));
    return Promise.race([r as Promise<T>, late]).finally(() => this.clock.clearTimeout(t));
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
   * Вызов модуля в ловушке. Ошибка не идёт дальше: модуль выключается в сессии s (или на машине), onFail даёт замену.
   * Refusal — отказ словом, его ловит вызывающий.
   */
  call<T>(name: string, where: string, s: Sess | null, fn: (m: Module, mod: Mod) => T | Promise<T>, onFail: (e: unknown) => T): T | Promise<T> {
    {
      const cur = this.byName.get(name);
      if (!cur) return onFail(new Error(`${name} снят`));
      if (this.isDown(cur, s)) return onFail(new Error(MODULE_ERROR));
      const failed = (e: unknown): T => {
        if (isRefusal(e)) throw e;
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

  /**
   * Ошибка вне вызова ядра — в работе, которую модуль начал сам (таймер, цепочка, событие): контекст вызова, где её
   * начали, наследуется, и модуль выключается там же. Модуль не определился — false: решает процесс (выход 1).
   */
  stray(e: unknown): boolean {
    const st = this.als.getStore();
    const m = st && this.byName.get(st.mod);
    if (!m) return false;
    this.disable(m, st.sess, "работа вне вызова ядра", e);
    return true;
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
    return this.waitHuman<PermissionResult>(s, owner, (m, mod) => {
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
    return this.waitHuman<ElicitationResult>(s, owner, (m, mod) => {
      if (!m.elicit) throw new Error("elicit нет в новой версии");
      return m.elicit(s.facade(mod), req as never, o);
    }, "elicit", () => decline);
  }

  /** Вызов, ждущий человека: сбой модуля — ответ onFail. */
  private waitHuman<T>(s: Sess, owner: string, fn: (m: Module, mod: Mod) => T | Promise<T>, where: string, onFail: () => T): Promise<T> {
    return Promise.resolve(this.call(owner, where, s, fn, onFail)).then(
      (r) => r,
      () => onFail(),
    );
  }

  // ───────────── держатели ─────────────

  private onExited(e: Exited): void {
    this.sessions.get(e.id)?.onExited(e);
  }

  // ───────────── relay ─────────────

  private connectRelay(): void {
    const url = this.deps.config.relay;
    if (!url || this.shutting) return;
    const workers = this.deps.config.workers ?? {};
    this.relay = fleet({
      relay: url,
      gate: workers.gate ?? "",
      workers,
      key: this.deps.relayKey ?? "",
      machine: this.machine,
      hello: () => ({
        sdk: this.sdkVersion,
        contract: this.contract(),
        sessions: [...this.sessions.values()].map((s) => s.helloRecord()),
      }),
      onFrame: (f) => this.onFrame(f),
      // своя машина — связь Host; другие — гостевые соединения, строка журнала; "" — список машин у gate
      onState: (m, st, why) => (m === this.machine ? this.onRelayState(st, why) : this.log("core", { ev: `guest_${st}`, why: `${m || "keys.list"}${why ? " · " + why : ""}` })),
      onLost: (f, word) => this.log("core", { kind: "note", ev: f.type, word, why: `${f.type} → ${String(f.to)} не дошёл: ${word}` }),
      WebSocket: this.deps.WebSocket,
      fetch: this.deps.fetch,
      pingMs: this.deps.pingMs,
      pauseMs: this.deps.pauseMs,
    });
  }

  private onRelayState(st: LinkState, why?: string): void {
    if (st === "stopped") {
      if (why === "shutting_down") return;
      this.log("core", { kind: "stop", ev: "relay_stopped", word: why, why: `relay закрыл соединение: ${why} — Host не переподключается` });
    } else if (st === "closed") this.log("core", { ev: "relay_closed", why: why ?? "" });
    else if (st === "open") this.log("core", { ev: "hello", why: "hello принят" });
  }

  /** Кадр в relay; связи нет — disconnected, больше предела кадра — too_large (слово ставит клиент рации). */
  send(f: Frame): Result {
    return this.relay?.send(f) ?? { ok: false, error: "disconnected" };
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
      void this.call(owner.name, `frames.${f.type}`, s, (m, mod) => m.frames![f.type](f, this.ctx(mod, f.from)), () => undefined);
      return;
    }
    // roster флота — объединение roster объектов машин; держит ядро, модули, которым он нужен событием, получают его как кадр
    if (f.type === "roster") f = (this.lastRoster = this.relay?.roster ?? (f as Roster)) as unknown as Frame;
    let got = f.type === "roster";
    for (const m of this.mods) {
      if (!m.module.on?.frame || !Object.keys(m.manifest.uses ?? {}).some((r) => nameOf(r) === f.type)) continue;
      got = true;
      void this.call(m.name, "on.frame", null, (x) => x.on!.frame!(f), () => undefined);
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
    // имя обслуживается и версия совпадает — одно правило с участниками рации
    const owner = this.reqOwner.get(f.type);
    const bad = accepts(f, owner ? { [f.type]: owner.manifest.provides[f.type] } : {});
    if (bad || !owner) {
      this.log("core", { kind: "refuse", ev: "request", word: bad!.word, id: f.id, from: f.from, why: owner ? `${bad!.why} (${owner.name})` : bad!.why });
      return fail(f.id, bad!.word);
    }
    let s: Sess | null = null;
    if (typeof f.callsign === "string") {
      s = this.sessions.get(f.callsign) ?? null;
      // сессии ещё нет: запрос модуля этой машины (manage спрашивает slots до host.open) — решает модуль-владелец;
      // запрос клиента через relay — offline, адресата нет
      if (!s && (from === undefined || machineOf(f.callsign) !== this.machine)) {
        this.log("core", { kind: "refuse", ev: "request", word: "offline", id: f.id, from: f.from, why: `${f.type}: сессии ${f.callsign} нет на машине` });
        return fail(f.id, "offline");
      }
    }
    // запрос о сессии, которой нет (модуль этой машины спросил про только что убранную): сбой владельца — отказ
    // module_error с причиной в журнале, а не выключение модуля на всей машине (живой прогон 31 окт.: session.spec
    // про убранную сессию выключил host-manage на машине до перезапуска Host)
    const orphan = typeof f.callsign === "string" && !s;
    const run = (m: Module, mod: Mod) => {
      const call = () => m.requests![f.type](f, this.ctx(mod, from ?? f.from));
      if (!orphan) return call();
      return Promise.resolve()
        .then(call)
        .catch((e: unknown) => {
          if (isRefusal(e)) throw e;
          const stack = e instanceof Error && e.stack ? e.stack : String(e);
          this.log("core", { kind: "refuse", ev: "request", word: MODULE_ERROR, id: f.id, module: owner.name, why: `${f.type} о сессии ${f.callsign}, которой нет: ${stack}` });
          throw refuse(MODULE_ERROR, `${f.type}: сессии ${f.callsign} нет`);
        });
    };
    try {
      const r = await this.call(owner.name, `requests.${f.type}`, s, run, () => SKIP);
      if (r === SKIP) {
        this.log("core", { kind: "refuse", ev: "request", word: MODULE_ERROR, id: f.id, from: f.from, module: owner.name, why: `${f.type}: модуль ${owner.name} выключен${s ? " в " + s.callsign : ""}` });
        return fail(f.id, MODULE_ERROR);
      }
      return ok(f.id, r);
    } catch (e) {
      if (!isRefusal(e)) throw e;
      const word = e.word;
      this.log(owner.name, { kind: "refuse", ev: "request", word, id: f.id, from: f.from, why: e.why ?? `${f.type}: ${word}` });
      return fail(f.id, word);
    }
  }

  // ───────────── что ядро даёт модулю ─────────────

  hostFacade(m: Mod): Host {
    let h = this.hostFacades.get(m);
    if (h) return h;
    const k = this;
    h = {
      get dataDir() {
        return k.deps.home;
      },
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
      roster: () => k.lastRoster,
    };
    this.hostFacades.set(m, h);
    return h;
  }

  /** host.request: имя из uses или своё; владелец — модуль этой машины или через relay: другая машина, часть машины, служба. */
  async request(m: Mod, name: string, payload: Record<string, unknown>): Promise<Result> {
    const caller = this.callerSession(m);
    const own = m.manifest.provides?.[name] !== undefined;
    const ref = Object.keys(m.manifest.uses ?? {}).find((r) => nameOf(r) === name);
    if (!own && !ref) this.violation(m, caller, `${name} нет в uses`);
    const owner = own ? m.name : ownerOf(ref!);
    // версия — из своих provides или uses модуля, если вызов её не назвал
    if (payload.v === undefined) payload = { ...payload, v: own ? m.manifest.provides![name] : m.manifest.uses![ref!] };
    const target = hostOf(payload) ?? null;

    const local = this.byName.has(owner) && (target === null || target === this.machine) && !(payload.to && typeof payload.to !== "string");
    if (local) {
      const id = `${this.idPrefix}-${++this.reqSeq}`;
      // отправитель — как через relay: from запроса, иначе машина; владелец видит его в ctx.from и не выбирает сам
      const from = kindOf(payload.from) ? (payload.from as string) : `@${this.machine}`;
      const r = await this.handleRequest({ ...payload, type: name, id, from } as Frame & { id: string }, from);
      return r.ok ? { ok: true, result: r.result } : { ok: false, error: r.error };
    }
    if (!this.relay) return { ok: false, error: "disconnected" };
    const frame: Frame = { ...payload, type: name };
    // участник рации — .имя, даже если в запросе есть поля machine или callsign; keeper машины адресуется явно: .keeper@машина
    if (!this.byName.has(owner) && payload.to === undefined) frame.to = serviceAddress(owner);
    // отказ несёт все поля reply владельца (missing, owner, creds…), без конверта
    const { type: _t, id: _i, to: _to, from: _f, ...r } = (await this.relay.request(frame)) as Frame & Reply;
    return r as Result;
  }

  /** s.field: поле записи сессии этой машины у владельца — имя из своих provides или uses, как у запроса. */
  sessionField(m: Mod, s: Sess, name: string): unknown {
    const own = m.manifest.provides?.[name] !== undefined;
    const ref = Object.keys(m.manifest.uses ?? {}).find((r) => nameOf(r) === name);
    if (!own && !ref) this.violation(m, s, `${name} нет в uses`);
    const owner = this.byName.get(own ? m.name : ownerOf(ref!));
    return owner?.module.fields?.[name] ? s.field(owner, name) : undefined;
  }

  /** host.emit: кадр без ответа; type — свой или из uses. Связи нет — disconnected, очереди нет; больше предела кадра — too_large. */
  emit(m: Mod, f: Frame): Result {
    const known = m.manifest.provides?.[f.type] !== undefined || Object.keys(m.manifest.uses ?? {}).some((r) => nameOf(r) === f.type);
    if (!known) this.violation(m, this.callerSession(m), `${f.type} нет в provides и uses`);
    const ref = Object.keys(m.manifest.uses ?? {}).find((r) => nameOf(r) === f.type);
    // версия — как у request: из provides или uses, если кадр её не назвал
    if (f.v === undefined) f = { ...f, v: m.manifest.provides?.[f.type] ?? m.manifest.uses![ref!] };
    return this.send(f);
  }

  private probe(m: Mod, env?: Record<string, string>): Probe {
    const q = this.deps.sdk.query({
      prompt: new InputQueue().stream(),
      options: {
        env: { ...process.env, ...(env ?? {}), DISABLE_UPDATES: "1" },
        ...(this.deps.sdk.bin ? { pathToClaudeCodeExecutable: this.deps.sdk.bin } : {}),
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
    // у живой сессии заголовок меняет её query: и в файле разговора, и в claude.ai
    if (name === "renameSession" && s.q) return (s.q as unknown as { renameSession: (t: unknown, id: string) => Promise<unknown> }).renameSession(args[0], s.rec.session_id);
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
      ...(spec.resume && spec.fork ? { fork: spec.resume } : {}),
    };
    const s = new Sess(this, rec);
    const kind = spec.point !== undefined ? "point" : spec.resume ? "resume" : "spawn";
    s.prepare(kind, spec.point);
    let parts;
    try {
      parts = await s.collectParts();
    } catch (e) {
      this.log("core", { kind: "stop", ev: "open", callsign: spec.callsign, why: (e as Error).message });
      throw e;
    }
    this.sessions.set(rec.callsign, s);
    this.saveCore();
    this.log("core", { ev: "open", callsign: rec.callsign, cwd: rec.cwd });
    await s.launch(kind, { parts, first: spec.resume ? { resume: spec.resume, fork: spec.fork } : { fresh: true } });
    return s;
  }

  // ───────────── штатная остановка ─────────────

  /**
   * Ввод Host закрыт (keeper меняет версию) или сигнал ОС: новые запросы — shutting_down, начатые доводятся,
   * stop() модулей; процессы claude живут у своих держателей, новый Host подключится к ним.
   */
  shutdown(reason: string): Promise<void> {
    if (this.shutting) return this.shutting;
    this.shutting = new Promise<void>((done) => {
      // предел остановки: что-то ждёт без конца — причина в журнал и жёсткий выход; процессы claude живут у держателей
      const limit = this.deps.stopMs ?? 30_000;
      let stage = "начатые запросы";
      let late = false;
      const timer = this.clock.setTimeout(() => {
        late = true;
        this.log("core", { kind: "stop", ev: "shutdown_late", why: `остановка не успела за ${limit / 1000} с: ждёт ${stage} — жёсткий выход 1 · ${reason}` });
        this.deps.exit?.(1);
        done();
      }, limit);
      void (async () => {
        this.log("core", { ev: "shutdown", why: `остановка: ${reason}` });
        this.abort.abort();
        await Promise.allSettled([...this.inflight]);
        for (const s of this.sessions.values()) s.shutdown();
        for (const m of [...this.mods].reverse()) {
          if (!m.module.stop || m.down) continue;
          stage = `stop() модуля ${m.name}`;
          await this.call(m.name, "stop", null, (x) => x.stop!(), () => undefined);
        }
        if (late) return;
        this.clock.clearTimeout(timer);
        for (const q of this.probes) q.close();
        this.relay?.close(1000, "shutting_down");
        this.holders.close();
        this.log("core", { ev: "exit", why: `выход 0 · ${reason}` });
        this.deps.exit?.(0);
        done();
      })();
    });
    return this.shutting;
  }
}

export type { Session };
