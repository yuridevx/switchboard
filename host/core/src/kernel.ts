// Ядро Host: собирает части и ведёт жизнь Host — старт, открытие сессии, штатная остановка, Host глазами модуля.
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Query } from "@anthropic-ai/claude-agent-sdk";
import { machineOf } from "@switchboard/protocol";
import type { WsCtor } from "@switchboard/relay";
import type { Host, LogRecord, Manifest, OpenSpec, Probe, Store } from "../contract.ts";
import type { Clock } from "./clock.ts";
import { realClock } from "./clock.ts";
import { Decisions } from "./decisions.ts";
import { HolderClient } from "./holders.ts";
import type { HolderApi } from "./holders.ts";
import { journal } from "./journal.ts";
import type { Journal } from "./journal.ts";
import { InputQueue } from "./queue.ts";
import { isRefusal, refuse } from "./refusal.ts";
import { gate } from "./registry.ts";
import type { Release } from "./release.ts";
import { refOf, Router } from "./router.ts";
import { Sess, STOP_MS } from "./session.ts";
import type { SdkApi, SessionDeps } from "./session.ts";
import { Stores } from "./store.ts";
import type { CoreRecord } from "./store.ts";
import { handled, Mod, START_MS, Trap } from "./trap.ts";

export { Mod };
export type { SdkApi };

/** Конфиг Host: машина — из окружения keeper, разделы модулей — ~/.switchboard/host.json. Адреса флота — в выпуске. */
export type HostConfig = {
  machine: string;
  /** разделы модулей: host.config() */
  modules?: Record<string, unknown>;
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

export class Kernel {
  readonly sessions = new Map<string, Sess>();
  readonly holders: HolderClient;
  shutting: Promise<void> | null = null;
  private readonly deps: Deps;
  private readonly machine: string;
  private readonly clock: Clock;
  private readonly stores: Stores;
  private readonly journal: Journal;
  private readonly trap: Trap;
  private readonly decisions: Decisions;
  private readonly router: Router;
  private readonly abort = new AbortController();
  private readonly probes = new Set<Query>();
  private readonly hostViews = new Map<Mod, Host>();
  private readonly sessionDeps: SessionDeps;

  constructor(deps: Deps) {
    this.deps = deps;
    this.machine = deps.config.machine;
    this.clock = deps.clock ?? realClock;
    this.stores = new Stores(join(deps.home, "store"));
    this.journal = journal(join(deps.home, "journal"), this.machine, this.clock);
    const log = (rec: LogRecord) => this.journal("core", rec);
    this.holders = new HolderClient(deps.holders, { exited: (e) => this.sessions.get(e.id)?.onExited(e) });
    this.trap = new Trap({ log, clock: this.clock, pushAll: () => this.sessions.forEach((s) => s.push()) });
    this.decisions = new Decisions(this.trap, log);
    this.router = new Router({
      trap: this.trap,
      clock: this.clock,
      machine: this.machine,
      workers: deps.release.workers,
      relayKey: deps.relayKey,
      sdkVersion: deps.release.sdk,
      WebSocket: deps.WebSocket,
      fetch: deps.fetch,
      pingMs: deps.pingMs,
      pauseMs: deps.pauseMs,
      signal: this.abort.signal,
      sessions: this.sessions,
      log,
      logAs: this.journal,
      host: (m) => this.hostFacade(m),
      contract: () => Object.assign({}, ...this.trap.mods.map((m) => m.manifest.provides ?? {})),
      stopping: () => !!this.shutting,
      shutdown: (reason) => void this.shutdown(reason),
    });
    this.sessionDeps = {
      trap: this.trap,
      decisions: this.decisions,
      holders: this.holders,
      sdk: deps.sdk,
      stores: this.stores,
      clock: this.clock,
      sdkVersion: deps.release.sdk,
      log,
      saveCore: () => this.saveCore(),
      send: (f) => this.router.send(f),
      listed: (callsign) => this.sessions.has(callsign),
      unlist: (callsign) => void this.sessions.delete(callsign),
      fieldOwner: (m, scope, name) => {
        const ref = refOf(m, name);
        if (!ref) this.trap.violation(m, scope, `${name} нет в uses`);
        return this.trap.byName.get(ref.owner);
      },
    };
  }

  /** Стенд и живой прогон видят модули и связь через ядро. */
  get mods(): Mod[] {
    return this.trap.mods;
  }
  get byName(): Map<string, Mod> {
    return this.trap.byName;
  }
  get relay() {
    return this.router.relay;
  }

  /** Ошибка вне вызова ядра: см. Trap.stray. */
  stray(e: unknown): boolean {
    return this.trap.stray(e);
  }

  private log(rec: LogRecord): void {
    this.journal("core", rec);
  }

  private saveCore(): void {
    const list: CoreRecord[] = [...this.sessions.values()].map((s) => s.rec);
    this.stores.saveCore(list);
  }

  // ───────────── старт ─────────────

  /** Старт Host по шагам дизайна. Гейт не прошёл — StartError, сессии у держателей не тронуты. */
  async start(): Promise<void> {
    const { core, release } = this.deps;
    const { fatal, down } = gate(core, release.modules, !!release.workers.relay);
    if (fatal.length) this.refuseStart(fatal);
    const mods = release.modules.map((e) => new Mod(e.manifest, down.has(e.manifest.name) ? {} : e.module));
    this.trap.load(mods);
    this.decisions.index(mods);
    this.router.index(mods);
    this.log({ ev: "host_start", version: release.version, sdk: release.sdk, modules: mods.map((m) => `${m.name} ${m.manifest.version}`) });
    // модуль с ошибкой своего кода — выключен на машине (failed в roster), Host работает без него
    for (const m of mods) if (down.has(m.name)) this.trap.disable(m, null, "гейт старта", new Error(down.get(m.name)!.join("; ")));
    for (const m of mods) {
      if (m.module.start) await this.trap.call(m, "start", null, (x) => this.trap.within(x.start!(this.hostFacade(m)), `start() не вернулся за ${START_MS / 1000} с`), () => undefined);
    }

    const held = this.holders.list();
    for (const rec of this.stores.core()) this.sessions.set(rec.callsign, new Sess(this.sessionDeps, rec));
    const alive = new Set(held.map((p) => p.id));
    for (const p of held) {
      if (this.sessions.has(p.id)) continue;
      this.log({ kind: "stop", ev: "orphan_kill", callsign: p.id, why: `процесс ${p.id} (pid ${p.pid}) не в списке сессий — kill` });
      await this.killOrphan(p.id);
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
      this.holders.close();
      this.refuseStart(conflicts);
    }
    for (const s of this.sessions.values()) {
      if (s.rec.stopped) s.state = "stopped";
      else void s.launch(alive.has(s.callsign) ? "attach" : "resume", { parts: parts.get(s) }).catch(() => {});
    }
    this.router.connect();
    await Promise.all([...this.sessions.values()].map((s) => s.settled()));
    if (this.shutting) return;
    this.log({ ev: "ready", version: release.version });
    for (const m of mods) if (m.module.on?.ready) this.trap.call(m, "on.ready", null, (x) => x.on!.ready!(), () => undefined);
  }

  /** Ничей держатель молчит на kill: старт не ждёт его без конца, кадр уже ушёл. */
  private killOrphan(id: string): Promise<void> {
    return new Promise((done) => {
      const late = this.clock.setTimeout(() => {
        this.log({ kind: "stop", ev: "orphan_late", callsign: id, why: `держатель ${id} не вышел за ${STOP_MS / 1000} с после kill — старт идёт дальше` });
        done();
      }, STOP_MS);
      void this.holders.kill(id).then(() => {
        this.clock.clearTimeout(late);
        done();
      });
    });
  }

  private refuseStart(reasons: string[]): never {
    for (const why of reasons) this.log({ kind: "stop", ev: "gate", word: "check_failed", why });
    throw new StartError(reasons);
  }

  // ───────────── открытие сессии ─────────────

  /** host.open: новая сессия в списке ядра; ответ — после initialize. */
  async open(spec: OpenSpec): Promise<Sess> {
    if (this.shutting) throw new Error("shutting_down");
    if (machineOf(spec.callsign) !== this.machine) throw new Error(`${spec.callsign}: callsign не этой машины`);
    if (this.sessions.has(spec.callsign)) throw new Error(`${spec.callsign}: имя занято`);
    const rec: CoreRecord = {
      callsign: spec.callsign,
      cwd: spec.cwd,
      session_id: spec.resume && !spec.fork ? spec.resume : randomUUID(),
      sdk: this.deps.release.sdk,
      stopped: false,
      ...(spec.resume && spec.fork ? { fork: spec.resume } : {}),
    };
    const s = new Sess(this.sessionDeps, rec);
    const kind = spec.point !== undefined ? "point" : spec.resume ? "resume" : "spawn";
    s.prepare(kind, spec.point);
    let parts;
    try {
      await s.collectOpening(spec.opening ?? {});
      parts = await s.collectParts();
      // папка — последним шагом сборки: отказ модуля её не оставляет
      if (spec.mkdir) {
        try {
          mkdirSync(spec.cwd, { recursive: true });
        } catch (e) {
          throw refuse("bad_dir", `${spec.callsign}: папка ${spec.cwd} не создана — ${(e as Error).message}`);
        }
      }
    } catch (e) {
      // разделы несостоявшейся сессии стёрты: повторное открытие того же имени начинает с чистого
      this.stores.removeSession(spec.callsign);
      if (!isRefusal(e)) this.log({ kind: "stop", ev: "open", callsign: spec.callsign, why: (e as Error).message });
      throw e;
    }
    this.sessions.set(rec.callsign, s);
    this.saveCore();
    this.log({ ev: "open", callsign: rec.callsign, cwd: rec.cwd });
    await s.launch(kind, { parts, first: spec.resume ? { resume: spec.resume, fork: spec.fork } : { fresh: true } });
    return s;
  }

  // ───────────── Host глазами модуля ─────────────

  hostFacade(m: Mod): Host {
    const known = this.hostViews.get(m);
    if (known) return known;
    const k = this;
    const { deps, router, stores, sessions, journal: write } = this;
    const view: Host = {
      machine: this.machine,
      dataDir: deps.home,
      version: deps.release.version,
      sdk: deps.release.sdk,
      session: (callsign) => sessions.get(callsign)?.facade(m),
      sessions: () => [...sessions.values()].map((s) => ({ callsign: s.callsign, cwd: s.rec.cwd, state: s.state })),
      open: async (spec) => (await k.open(spec)).facade(m),
      request: (name, payload) => handled(router.request(m, name, payload)),
      read: (name, payload) => handled(router.request(m, name, payload, true)),
      emit: (frame) => router.emit(m, frame),
      store: <T>() => stores.machine<T>(m.name) as Store<T>,
      config: <T>() => (deps.config.modules?.[m.name] ?? {}) as T,
      log: (rec) => write(m.name, rec),
      probe: (o) => k.probe(m, o?.env),
      cli: (args, o) => deps.sdk.cli(args, { ...process.env, ...(o?.env ?? {}), DISABLE_UPDATES: "1" }, o?.input),
      roster: () => router.roster,
    };
    this.hostViews.set(m, view);
    return view;
  }

  private probe(m: Mod, env?: Record<string, string>): Probe {
    const { sdk } = this.deps;
    const q = sdk.query({
      prompt: new InputQueue().stream(),
      options: {
        env: { ...process.env, ...(env ?? {}), DISABLE_UPDATES: "1" },
        ...(sdk.bin ? { pathToClaudeCodeExecutable: sdk.bin } : {}),
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
      },
    });
    this.probes.add(q);
    return {
      sdk: (name, ...args) =>
        handled(
          (async () => {
            if (!(m.manifest.calls ?? []).includes(name)) this.trap.violation(m, this.trap.callerOf(m), `${name} нет в calls`);
            return (q as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[name](...args);
          })(),
        ),
      close: () => {
        this.probes.delete(q);
        q.close();
      },
    };
  }

  // ───────────── штатная остановка ─────────────

  /**
   * Ввод Host закрыт (keeper меняет версию) или сигнал ОС: новые запросы — shutting_down, начатые доводятся,
   * stop() модулей; процессы claude живут у своих держателей, новый Host подключится к ним.
   */
  shutdown(reason: string): Promise<void> {
    this.shutting ??= new Promise<void>((done) => {
      // предел остановки: что-то ждёт без конца — причина в журнал и жёсткий выход; процессы claude живут у держателей
      const limit = this.deps.stopMs ?? 30_000;
      let stage = "начатые запросы";
      let late = false;
      const timer = this.clock.setTimeout(() => {
        late = true;
        this.log({ kind: "stop", ev: "shutdown_late", why: `остановка не успела за ${limit / 1000} с: ждёт ${stage} — жёсткий выход 1 · ${reason}` });
        this.deps.exit?.(1);
        done();
      }, limit);
      void (async () => {
        this.log({ ev: "shutdown", why: `остановка: ${reason}` });
        this.abort.abort();
        await Promise.allSettled([...this.router.inflight]);
        for (const s of this.sessions.values()) s.shutdown();
        for (const m of [...this.trap.mods].reverse()) {
          if (!m.module.stop || m.down) continue;
          stage = `stop() модуля ${m.name}`;
          await this.trap.call(m, "stop", null, (x) => x.stop!(), () => undefined);
        }
        if (late) return;
        this.clock.clearTimeout(timer);
        for (const q of this.probes) q.close();
        this.router.relay?.close(1000, "shutting_down");
        this.holders.close();
        this.log({ ev: "exit", why: `выход 0 · ${reason}` });
        this.deps.exit?.(0);
        done();
      })();
    });
    return this.shutting;
  }
}
