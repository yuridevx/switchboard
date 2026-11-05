// Ядро Host: собирает модули и сессии, держит связь с флотом, ведёт кадры к владельцам. Функций не знает.
//
// Старт: гейт → модули start() → вклады сессий (два владельца — не стартует) → ничьи процессы убиты → relay → процессы → ready.
// Остановка: не принимает новое → начатые запросы → stop() модулей обратным порядком → соединения закрыты, процессы живут у держателей → выход.
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { accepts, hostOf, kindOf, machineOf, READ_MS, serviceAddress } from "@switchboard/protocol";
import type { Frame } from "@switchboard/protocol";
import { nameOf } from "@switchboard/manifest-gate";
import { fleet } from "@switchboard/relay";
import type { FleetClient, Roster, WsCtor } from "@switchboard/relay";
import type { Ctx, Host, LogRecord, Manifest, OpenSpec, Probe, Result, Session, StartKind } from "../contract.ts";
import { limit, realClock, type Clock } from "./clock.ts";
import { moduleProblems, relayProblems, setProblems } from "./gate.ts";
import { Holders, type HolderApi } from "./holders.ts";
import { Journal } from "./journal.ts";
import { isRefusal, refuse } from "./refusal.ts";
import type { Release, SdkApi } from "./release.ts";
import { Sess, type SessionEnv } from "./session.ts";
import { Stores, type CoreRecord } from "./store.ts";
import { handled, Mod, Trap } from "./trap.ts";

export { Mod };

const SHUTDOWN_MS = 30_000;
const ORPHAN_MS = 30_000;

export type HostConfig = { machine: string; modules?: Record<string, unknown> };

export type KernelOptions = {
  home: string;
  config: HostConfig;
  core: Manifest;
  release: Release;
  sdk: SdkApi;
  holders: HolderApi;
  /** пропуск машины из machine.key */
  relayKey?: string;
  WebSocket?: WsCtor;
  fetch?: typeof fetch;
  clock?: Clock;
  exit?: (code: number) => void;
  pauseMs?: number;
};

/** Host не стартует: причины строками. */
export class StartError extends Error {
  readonly reasons: string[];

  constructor(reasons: string[]) {
    super(reasons.join("; "));
    this.reasons = reasons;
  }
}

type Answer = { ok: true; result?: unknown } | { ok: false; error: string; why?: string };

export class Kernel {
  readonly mods: Mod[];
  readonly byName: Map<string, Mod>;
  readonly sessions = new Map<string, Sess>();
  readonly holders: Holders;
  relay: FleetClient | null = null;
  /** Остановка идёт или прошла. */
  shutting: Promise<void> | undefined;

  private readonly o: KernelOptions;
  private readonly machine: string;
  private readonly clock: Clock;
  private readonly journal: Journal;
  private readonly stores: Stores;
  private readonly trap: Trap;
  private readonly env: SessionEnv;
  private readonly owners = new Map<string, Mod>();
  private readonly contract: Record<string, number> = {};
  private readonly hosts = new Map<Mod, Host>();
  private readonly stopping = new AbortController();
  /** имена сессий, которые открываются прямо сейчас */
  private readonly opening = new Set<string>();
  private readonly inflight = new Set<Promise<unknown>>();
  private readonly probes = new Set<Probe>();
  private lastRoster: Roster | null = null;
  private modulesStarted = false;

  constructor(o: KernelOptions) {
    this.o = o;
    this.machine = o.config.machine;
    this.clock = o.clock ?? realClock;
    this.journal = new Journal(join(o.home, "journal"), this.machine, this.clock);
    this.stores = new Stores(join(o.home, "store"));
    this.holders = new Holders(o.holders);
    this.trap = new Trap(this.journal, this.clock, () => this.sessions.values());
    this.mods = o.release.modules.map((e) => new Mod(e.manifest, e.module));
    this.byName = new Map(this.mods.map((m) => [m.name, m]));
    for (const m of this.mods) {
      for (const [name, v] of Object.entries(m.manifest.provides)) {
        if (!this.owners.has(name)) this.owners.set(name, m);
        this.contract[name] = v;
      }
    }
    this.env = {
      sdk: o.sdk,
      sdkVersion: o.release.sdk,
      clock: this.clock,
      trap: this.trap,
      mods: this.mods,
      owners: this.owners,
      stores: this.stores,
      holders: this.holders,
      log: (r) => this.log(r),
      saveRecords: () => this.saveRecords(),
      send: (f) => this.relay?.send(f) ?? { ok: false },
      shutting: () => this.shutting !== undefined,
      forget: (s) => {
        this.sessions.delete(s.callsign);
        this.saveRecords();
        this.stores.forget(s.callsign);
      },
    };
  }

  private log(record: LogRecord): void {
    this.journal.write("core", record);
  }

  private saveRecords(): void {
    this.stores.saveRecords([...this.sessions.values()].map((s) => s.rec));
  }

  /** Ошибка вне вызова ядра — из обработчика процесса: true — выключен модуль, false — ничья. */
  stray(e: unknown): boolean {
    return this.trap.stray(e);
  }

  // ───────────────── старт ─────────────────

  private refuseStart(reasons: string[]): StartError {
    for (const why of reasons) this.log({ kind: "stop", ev: "gate", word: "check_failed", why });
    return new StartError(reasons);
  }

  async start(): Promise<void> {
    const { core, release } = this.o;
    const manifests = release.modules.map((e) => e.manifest);
    this.log({ ev: "host_start", version: release.version, sdk: release.sdk, modules: manifests.map((m) => `${m.name} ${m.version}`) });
    const reasons = [...(release.workers.relay ? [] : relayProblems(core, manifests)), ...setProblems(core, manifests)];
    if (reasons.length) throw this.refuseStart(reasons);
    release.modules.forEach((entry, i) => {
      const problems = moduleProblems(entry);
      if (problems.length) this.trap.fail(this.mods[i], undefined, "гейт старта", problems.join("; "));
    });

    const files = this.holders.files();
    for (const rec of this.stores.records()) {
      const s = new Sess(this.env, rec, files.some((f) => f.id === rec.callsign) ? "attach" : "resume");
      s.listed = true;
      this.sessions.set(rec.callsign, s);
    }

    this.modulesStarted = true;
    for (const m of this.mods) {
      if (!m.isOff() && m.module.start) await this.trap.limited(m, undefined, "start", () => m.module.start!(this.hostFacade(m)), undefined);
    }

    const going = [...this.sessions.values()].filter((s) => !s.rec.stopped);
    await Promise.all(going.map((s) => s.aim(s.startKind as "attach" | "resume")));
    const conflicts = (await Promise.all(going.map((s) => s.prepare()))).flat();
    if (conflicts.length) throw this.refuseStart(conflicts);

    await Promise.all(files.filter((f) => !this.sessions.has(f.id)).map((f) => this.killOrphan(f)));
    this.connect();

    for (const s of going) void s.launch().catch(() => {}); // сбой подъёма сессия ведёт сама
    const halted = new Promise<void>((r) => this.stopping.signal.addEventListener("abort", () => r()));
    await Promise.race([Promise.all(going.map((s) => s.settled())), halted]);
    if (this.shutting) return;

    this.log({ ev: "ready", version: release.version });
    for (const m of this.mods) if (!m.isOff()) this.trap.call(m, undefined, "on.ready", () => m.module.on?.ready?.(), undefined);
  }

  /** Процесс, которого нет в списке сессий: k и не дольше предела, старт его не ждёт сверх этого. */
  private async killOrphan(file: Parameters<Holders["open"]>[0]): Promise<void> {
    this.log({ kind: "stop", ev: "orphan_kill", callsign: file.id, why: `процесс ${file.id} (pid ${file.pid}) не в списке сессий — kill` });
    const held = this.holders.open(file);
    held.terminate();
    const gone = await limit(this.clock, held.exit.then(() => true), ORPHAN_MS, () => false);
    if (gone) return;
    held.drop();
    this.log({ kind: "stop", ev: "orphan_late", callsign: file.id, why: `держатель ${file.id} не вышел за ${ORPHAN_MS / 1000} с после kill — старт идёт дальше` });
  }

  private connect(): void {
    const { release, relayKey, WebSocket, pauseMs } = this.o;
    if (!release.workers.relay) return;
    this.relay = fleet({
      workers: release.workers,
      key: relayKey ?? "",
      machine: this.machine,
      WebSocket,
      fetch: this.o.fetch,
      pauseMs,
      hello: () => ({ sdk: release.sdk, contract: this.contract, sessions: [...this.sessions.values()].map((s) => s.hello()) }),
      onFrame: (f) => this.onFrame(f),
      onLost: (f, word) => this.log({ ev: f.type, word, why: `${f.type} → ${String(f.to)} не дошёл: ${word}` }),
      onState: (machine, state, why) => this.onLink(machine, state, why),
    });
  }

  private onLink(machine: string, state: string, why?: string): void {
    if (machine !== this.machine) {
      // соединения с чужими машинами и список машин у gate
      this.log({ ev: `guest_${state}`, why: `${machine || "keys.list"}${why ? ` · ${why}` : ""}` });
    } else if (state === "open") {
      this.log({ ev: "hello", why: "hello принят" });
      for (const s of this.sessions.values()) s.refresh(); // состояние, сменившееся между hello и roster
    } else if (state === "closed") {
      this.log({ ev: "relay_closed", why: why ?? "" });
    } else if (state === "stopped" && why !== "shutting_down") {
      this.log({ kind: "stop", ev: "relay_stopped", word: why, why: `relay закрыл соединение: ${why} — Host не переподключается` });
      // keeper поднимет Host с нынешним machine.key
      if (why === "revoked" || why === "bad_key") void this.shutdown(`relay не принял пропуск машины: ${why}`);
    }
  }

  // ───────────────── кадры и запросы ─────────────────

  private ctx(mod: Mod, from: unknown): Ctx {
    return { host: this.hostFacade(mod), from: from as string | undefined, signal: this.stopping.signal };
  }

  private track<T>(work: Promise<T>): Promise<T> {
    this.inflight.add(work);
    void work.finally(() => this.inflight.delete(work)).catch(() => {});
    return work;
  }

  /** Сессия, о которой кадр: callsign или адрес to. */
  private aboutSession(f: Frame): Sess | undefined {
    const cs = typeof f.callsign === "string" ? f.callsign : typeof f.to === "string" && kindOf(f.to) === "session" ? f.to : undefined;
    return cs ? this.sessions.get(cs) : undefined;
  }

  private onFrame(f: Frame): void {
    if (f.type === "reply") return; // поздний ответ: его ждавшему уже ответил предел
    if (typeof f.id === "string") return void this.track(this.answerRelay(f));
    if (this.shutting) return;
    if (f.type === "roster") this.lastRoster = this.relay!.roster;
    const frame = f.type === "roster" ? (this.lastRoster as unknown as Frame) : f;
    const owner = this.owners.get(f.type);
    const handler = owner?.module.frames?.[f.type];
    if (owner && handler) {
      const place = this.aboutSession(f);
      if (!owner.isOff(place)) void this.trap.wait(owner, place, `frames.${f.type}`, () => handler(frame, this.ctx(owner, f.from)), undefined);
      return;
    }
    const readers = this.mods.filter((m) => m.module.on?.frame && Object.keys(m.manifest.uses).some((ref) => nameOf(ref) === f.type));
    for (const m of readers) if (!m.isOff()) this.trap.call(m, undefined, "on.frame", () => m.module.on!.frame!(frame), undefined);
    if (!readers.length && f.type !== "roster") this.log({ kind: "refuse", ev: "frame", word: "unknown_request", why: `кадр ${f.type}: владельца нет` });
  }

  private async answerRelay(f: Frame): Promise<void> {
    this.relay?.send({ type: "reply", id: f.id, ...(f.from ? { to: f.from } : {}), ...(await this.serve(f)) });
  }

  /** Запрос к модулю этой машины: и из relay, и от соседа. */
  private serve(f: Frame): Promise<Answer> {
    const refused = (word: string, why: string, extra: LogRecord | object = {}): Answer => {
      this.log({ kind: "refuse", ev: "request", word, id: f.id, from: f.from, why, ...extra });
      return { ok: false, error: word };
    };
    return (async (): Promise<Answer> => {
        if (this.shutting) return refused("shutting_down", `${f.type}: Host останавливается`);
        const owner = this.owners.get(f.type);
        const handler = owner?.module.requests?.[f.type];
        if (!owner || !handler) return refused("unknown_request", `${f.type} не обслуживается`);
        const wrong = accepts(f, this.contract);
        if (wrong) return refused(wrong.word, wrong.why);
        if (typeof f.callsign === "string" && !this.sessions.has(f.callsign)) return refused("offline", `${f.type}: сессии ${f.callsign} нет`);
        const place = this.aboutSession(f);
        if (owner.isOff(place)) return refused("module_error", `${f.type}: модуль ${owner.name} выключен${owner.down || !place ? "" : ` в ${place.callsign}`}`, { module: owner.name });
        let refusal: { word: string; why?: string } | undefined;
        const r = await this.trap.wait<Answer>(owner, place, `requests.${f.type}`, async () => {
          try {
            const result = await handler(f, this.ctx(owner, f.from));
            return { ok: true, result };
          } catch (e) {
            if (!isRefusal(e)) throw e;
            refusal = e;
            return { ok: false, error: e.word };
          }
        }, { ok: false, error: "module_error" });
        if (!refusal) return r;
        this.journal.write(owner.name, { kind: "refuse", ev: "request", word: refusal.word, id: f.id, from: f.from, why: refusal.why ?? `${f.type}: ${refusal.word}` });
        return { ok: false, error: refusal.word, ...(refusal.why ? { why: refusal.why } : {}) };
    })();
  }

  // ───────────────── Host глазами модуля ─────────────────

  private ask(mod: Mod, name: string, payload: Record<string, unknown>, read: boolean): Promise<Result> {
    const ref = mod.ref(name);
    if (!ref) return handled(Promise.reject(this.trap.violation(mod, undefined, `${name} нет в uses`)));
    const v = (payload.v as number | undefined) ?? ref.v;
    const target = hostOf(payload);
    if (this.byName.has(ref.owner) && (target == null || target === this.machine) && !Array.isArray(payload.to)) {
      const answer = this.serve({ ...payload, v, type: name, from: kindOf(payload.from) ? (payload.from as string) : `@${this.machine}` });
      return read ? limit(this.clock, answer, READ_MS, () => ({ ok: false, error: "timeout" })) : answer;
    }
    if (!this.relay) return Promise.resolve({ ok: false, error: "disconnected" });
    // владелец — Worker из адресов сборки: кадр без адреса — ему
    const toWorker = payload.to === undefined && this.o.release.workers[ref.owner] !== undefined;
    return handled(this.relay.request({ ...payload, v, type: name, ...(toWorker ? { to: serviceAddress(ref.owner) } : {}) }, read).then(({ type: _t, id: _i, to: _to, from: _f, ...rest }) => rest as Result));
  }

  private probe(mod: Mod, opts: { env?: Record<string, string> } = {}): Probe {
    let end = () => {};
    const closed = new Promise<void>((r) => (end = r));
    const q = this.o.sdk.query({
      prompt: (async function* () {
        await closed;
      })(),
      options: { env: { ...process.env, ...opts.env, DISABLE_UPDATES: "1" }, pathToClaudeCodeExecutable: this.o.sdk.bin, permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true },
    });
    const probe: Probe = {
      sdk: (name, ...args) => {
        if (!mod.manifest.calls?.includes(name)) return handled(Promise.reject(this.trap.violation(mod, undefined, `${name} нет в calls`)));
        return handled((q as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[name](...args));
      },
      close: () => {
        if (!this.probes.delete(probe)) return;
        end();
        q.close();
      },
    };
    this.probes.add(probe);
    return probe;
  }

  hostFacade(mod: Mod): Host {
    let host = this.hosts.get(mod);
    if (host) return host;
    const { release, sdk } = this.o;
    host = {
      machine: this.machine,
      dataDir: this.o.home,
      version: release.version,
      sdk: release.sdk,
      session: (callsign) => this.sessions.get(callsign)?.facade(mod) as Session | undefined,
      sessions: () => [...this.sessions.values()].map((s) => ({ callsign: s.callsign, cwd: s.rec.cwd, state: s.state })),
      open: async (spec) => (await this.open(spec)).facade(mod),
      request: (name, payload) => this.ask(mod, name, payload, false),
      read: (name, payload) => this.ask(mod, name, payload, true),
      emit: (frame) => {
        const ref = mod.ref(frame.type);
        if (!ref) throw this.trap.violation(mod, undefined, `${frame.type} нет в provides и uses`);
        return (this.relay?.send(frame.v === undefined ? { ...frame, v: ref.v } : frame) ?? { ok: false, error: "disconnected" }) as Result;
      },
      store: () => this.stores.section(mod.name),
      config: <T>() => (this.o.config.modules?.[mod.name] ?? {}) as T,
      log: (record) => this.journal.write(mod.name, record),
      probe: (opts) => this.probe(mod, opts),
      cli: (args, o = {}) => sdk.cli(args, { ...process.env, ...o.env, DISABLE_UPDATES: "1" }, o.input),
      roster: () => this.lastRoster,
    };
    this.hosts.set(mod, host);
    return host;
  }

  // ───────────────── открытие и остановка ─────────────────

  async open(spec: OpenSpec): Promise<Sess> {
    const { callsign, cwd } = spec;
    if (this.shutting) throw new Error("shutting_down");
    if (machineOf(callsign) !== this.machine) throw new Error(`${callsign}: callsign не этой машины`);
    if (this.sessions.has(callsign) || this.opening.has(callsign)) throw new Error(`${callsign}: имя занято`);
    const rec: CoreRecord = { callsign, cwd, session_id: spec.resume && !spec.fork ? spec.resume : randomUUID(), sdk: this.o.release.sdk, stopped: false, ...(spec.resume && spec.fork ? { fork: spec.resume } : {}) };
    const kind: StartKind = spec.point !== undefined ? "point" : spec.resume ? "resume" : "spawn";
    const s = new Sess(this.env, rec, kind, spec.point);
    this.opening.add(callsign);
    try {
      await s.opening(spec.opening ?? {});
      const conflicts = await s.prepare();
      if (conflicts.length) {
        const why = conflicts.join("; ");
        this.log({ kind: "stop", ev: "open", callsign, why });
        throw new Error(why);
      }
      if (spec.mkdir) {
        try {
          mkdirSync(cwd, { recursive: true });
        } catch (e) {
          throw refuse("bad_dir", `${callsign}: папка ${cwd} не создана — ${(e as Error).message}`);
        }
      }
    } catch (e) {
      this.stores.forget(callsign);
      throw e;
    } finally {
      this.opening.delete(callsign);
    }
    this.sessions.set(callsign, s);
    s.listed = true;
    this.saveRecords();
    this.log({ ev: "open", callsign, cwd });
    s.refresh();
    await s.launch();
    return s;
  }

  shutdown(why: string): Promise<void> {
    return (this.shutting ??= this.halt(why));
  }

  private async halt(why: string): Promise<void> {
    this.log({ ev: "shutdown", why: `остановка: ${why}` });
    this.stopping.abort();
    let waiting = "начатые запросы";
    const drained = async () => {
      await Promise.allSettled([...this.inflight]);
      if (this.modulesStarted) {
        for (const m of [...this.mods].reverse()) {
          if (m.isOff() || !m.module.stop) continue;
          waiting = `stop() модуля ${m.name}`;
          await this.trap.wait(m, undefined, "stop", () => m.module.stop!(), undefined);
        }
      }
      return true;
    };
    const inTime = await limit(this.clock, drained(), SHUTDOWN_MS, () => false);
    if (!inTime) this.log({ kind: "stop", ev: "shutdown_late", why: `остановка не успела за ${SHUTDOWN_MS / 1000} с: ждёт ${waiting} — жёсткий выход 1 · ${why}` });
    for (const p of [...this.probes]) p.close();
    this.holders.close();
    this.relay?.close(1000, "shutting_down");
    if (inTime) this.log({ ev: "exit", why: `выход 0 · ${why}` });
    this.o.exit?.(inTime ? 0 : 1);
  }
}

