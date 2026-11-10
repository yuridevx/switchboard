// Ядро Host: реестр модулей, старт и остановка, связь, вход запросов и кадров, сборка опций запуска, Host глазами модуля.
import { randomUUID } from "node:crypto";
import { mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  CALL_MS, contract, createApi, errFields, fail, httpTransport, isReply, machineOf, newId, ok, PROTO, Refusal, socketLink, stopwatch,
  type Api, type Frame, type Link, type LinkState, type Logger, type Reply, type RequestDef, type SessionState, type Spec, type Transport,
} from "@sb/protocol";
import { realClock, within, type Clock } from "./clock.ts";
import type { Ctx, DecideOpts, HostApi, Module, OpenOpts, PermissionResult, QueryPart, SessionApi } from "./contract.ts";
import { Holders, type HolderApi, type HoldFile } from "./holders.ts";
import { hostLogger } from "./journal.ts";
import { meter } from "./meter.ts";
import { clientPath } from "./paths.ts";
import { fleetPrompt } from "./prompt.ts";
import { Session, quiet, type Parts } from "./session.ts";
import { coreModule, CORE_KEYS } from "./sessions.ts";
import { Disk } from "./store.ts";

/** Предел вызова модуля на старте и при сборке опций. */
const MODULE_MS = 12_000;
const SHUTDOWN_MS = 30_000;
const KILL_MS = 30_000;
/** Окружение машины, которое доходит до claude; остальное про Claude подброшено мимо Host. */
const OWN_ENV = /^(CLAUDE|ANTHROPIC)_/i;
const KEPT_ENV = new Set(["CLAUDE_CODE_GIT_BASH_PATH", "CLAUDE_CONFIG_DIR"]);
/** Опции query(), которые держит ядро: процесс, разговор, решения. */
const CORE_OPTIONS = new Set(["prompt", "cwd", "resume", "sessionId", "forkSession", "continue", "allowDangerouslySkipPermissions", "spawnClaudeCodeProcess", "canUseTool", "onElicitation", "systemPrompt", "abortController", "pathToClaudeCodeExecutable", "title"]);
export const MODES: Record<string, string> = { all: "bypassPermissions", ask: "default", plan: "plan", edits: "acceptEdits", auto: "auto" };
/** Ключ документа → настройка Claude: вступает в силу сразу у живой сессии и стоит в опциях запуска. */
export const FLAGS = { effort: "effortLevel", fast: "fastMode", style: "outputStyle", thinking: "alwaysThinkingEnabled" } as const;
/** Сколько знаков первого сообщения идёт в заголовок. */
const TITLE_MAX = 80;

export type Sdk = {
  query(p: { prompt: AsyncIterable<any>; options: Record<string, unknown> }): any;
  functions: Record<string, (...a: any[]) => Promise<any>>;
  cli(args: string[], env: Record<string, string | undefined>, input?: string): Promise<{ code: number | null; out: string }>;
  bin?: string;
};

export type KernelOptions = {
  home: string;
  machine: string;
  fleet: string;
  /** адрес флота: https://… */
  base: string;
  /** пропуск машины */
  key: string;
  build: number;
  sdkVersion: string;
  modules: Module[];
  sdk: Sdk;
  holders: HolderApi;
  /** настройки модулей из host.json */
  config?: Record<string, unknown>;
  /** соединение с объектом машины; по умолчанию — настоящее */
  connect?: (o: { onFrame: (f: Frame) => void; onState: (s: LinkState) => void }) => Link;
  /** провод к службам; по умолчанию — POST /call */
  transport?: Transport;
  clock?: Clock;
  exit?: (code: number) => void;
  log?: Logger;
};

export class StartError extends Error {
  readonly reasons: string[];
  constructor(reasons: string[]) {
    super(reasons.join("; "));
    this.reasons = reasons;
  }
}

export class Kernel {
  readonly sessions = new Map<string, Session>();
  readonly mods: Module[];
  readonly holders: Holders;
  readonly disk: Disk;
  readonly clock: Clock;
  readonly sdk: Sdk;
  readonly version: string;
  readonly machine: string;
  readonly log: Logger;
  /** счётчики окна: сбои и возобновления процессов, время провайдера — модуль машины отдаёт их службе наблюдения */
  readonly meter = meter();
  readonly o: KernelOptions;
  shutting: Promise<void> | undefined;
  private requestOwners = new Map<string, Module>();
  private frameOwners = new Map<string, Module>();
  private specOwners = new Map<string, Module>();
  private decider: Module | undefined;
  private eliciter: Module | undefined;
  private abort = new AbortController();
  private inflight = new Set<Promise<unknown>>();
  private probes = new Set<{ close(): void }>();
  private hosts = new Map<Module, HostApi>();
  private link: Link | null = null;
  private linkState: LinkState = "closed";
  /** объект машины принял соединение (hello.ok): до него кадры не идут */
  private accepted = false;
  private pending = new Map<string, (r: Reply) => void>();
  private api: Api;
  /** имена сессий, которые открываются прямо сейчас */
  private opening = new Set<string>();

  constructor(o: KernelOptions) {
    this.o = o;
    this.machine = o.machine;
    this.clock = o.clock ?? realClock;
    this.sdk = o.sdk;
    this.version = o.sdkVersion;
    this.holders = new Holders(o.holders);
    this.disk = new Disk(join(o.home, "store"));
    this.log = o.log ?? hostLogger(o.home, o.machine, o.fleet, () => this.clock.now());
    this.mods = [coreModule(this), ...o.modules];
    this.api = createApi(o.transport ?? httpTransport({ base: o.base, key: o.key }));
  }

  save(): void {
    this.disk.saveRecords([...this.sessions.values()].map((s) => s.rec));
  }

  // ───────────────────────── реестр и вызов модулей ─────────────────────────

  /** У имени запроса, кадра, ключа документа и решения — один хозяин. */
  private gate(): string[] {
    const why: string[] = [];
    const claim = (map: Map<string, Module>, what: string, name: string, m: Module) => {
      const first = map.get(name);
      if (first) why.push(`${what} ${name}: два хозяина — ${first.name} и ${m.name}`);
      else map.set(name, m);
    };
    for (const m of this.mods) {
      for (const name of Object.keys(m.requests ?? {})) {
        claim(this.requestOwners, "запрос", name, m);
        if (!contract.request(name)) why.push(`запрос ${name} (${m.name}): нет в договоре`);
      }
      for (const name of Object.keys(m.frames ?? {})) claim(this.frameOwners, "кадр", name, m);
      for (const name of Object.keys(m.spec ?? {})) claim(this.specOwners, "ключ документа", name, m);
      if (m.decide) {
        if (this.decider) why.push(`решения: два хозяина — ${this.decider.name} и ${m.name}`);
        this.decider = m;
      }
      if (m.elicit) {
        if (this.eliciter) why.push(`формы: два хозяина — ${this.eliciter.name} и ${m.name}`);
        this.eliciter = m;
      }
    }
    return why;
  }

  /** Вызов кода модуля вне запроса: ошибка — строка журнала, модуль работает дальше. */
  private guard<T>(m: Module, where: string, callsign: string | undefined, fn: () => T): T | undefined {
    const failed = (e: unknown) => {
      if (e instanceof Refusal) this.log.warn(where, { module: m.name, callsign, word: e.word, why: e.why });
      else this.log.error(where, { module: m.name, callsign, word: "module_failed", ...errFields(e) });
      return undefined;
    };
    try {
      const r = fn();
      return (r instanceof Promise ? r.catch(failed) : r) as T;
    } catch (e) {
      return failed(e);
    }
  }

  /** Вызов всем модулям сессии по порядку списка. */
  each(s: Session, where: string, fn: (mod: Module, view: SessionApi) => unknown): void {
    for (const m of this.mods) this.guard(m, where, s.callsign, () => fn(m, s.facade(m)));
  }

  rowsOf(s: Session): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const m of this.mods) if (m.row) Object.assign(out, this.guard(m, "row", s.callsign, () => m.row!(s.facade(m))) ?? {});
    for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
    return out;
  }

  changed(what: string): void {
    for (const m of this.mods) this.guard(m, "on.changed", undefined, () => m.on?.changed?.(what));
  }

  /** Есть ли на этой машине хозяин запроса. */
  owns(request: string): boolean {
    return this.requestOwners.has(request);
  }

  specOwner(key: string): Module | undefined {
    return this.specOwners.get(key);
  }

  /** Сессия сменила состояние: итог хода дочерней сессии уходит родителю. */
  stateChanged(s: Session, state: SessionState, was: SessionState): void {
    if (state !== "idle" || (was !== "busy" && was !== "waiting")) return;
    const { parent } = s.rec.spec;
    if (!parent || !s.result || s.turnBy !== parent) return;
    const text = s.result;
    s.result = "";
    quiet(
      this.call(contract.request("message")!, { to: parent, text } as never, { from: s.callsign }).catch((e: unknown) =>
        this.log.warn("report", { callsign: s.callsign, to: parent, ...errFields(e), why: `итог хода не дошёл родителю: ${errFields(e).why}` }),
      ),
    );
  }

  // ───────────────────────── опции запуска ─────────────────────────

  private env(extra?: Record<string, string>): Record<string, string | undefined> {
    return { ...process.env, ...extra, DISABLE_UPDATES: "1", CLAUDE_CODE_HARBOR_KITE: "0" };
  }

  /** Вклады модулей в query(): у ключа один хозяин, второй — конфликт. */
  async parts(s: Session): Promise<Parts> {
    const conflicts: string[] = [];
    const env: Record<string, string> = {};
    const mcpServers: Record<string, unknown> = {};
    const settings: Record<string, unknown> = {};
    const options: Record<string, unknown> = {};
    const hooks: Record<string, unknown[]> = {};
    const append: string[] = [];
    const holders = new Map<string, string>();
    const claim = (word: string, target: Record<string, unknown>, from: Record<string, unknown> | undefined, who: string) => {
      for (const [k, v] of Object.entries(from ?? {})) {
        if (v === undefined) continue;
        const first = holders.get(`${word} ${k}`);
        if (first) conflicts.push(`${word} ${k}: два хозяина — ${first} и ${who}`);
        holders.set(`${word} ${k}`, who);
        target[k] = v;
      }
    };
    const lower: Array<NonNullable<QueryPart["defaults"]>> = [];
    const live = this.mods.filter((m) => m.compose);
    const got = await Promise.all(
      live.map((m) =>
        within<QueryPart | undefined>(this.clock, Promise.resolve().then(() => m.compose!(s.facade(m))), MODULE_MS, () => {
          conflicts.push(`${m.name}: compose не вернулся за ${MODULE_MS / 1000} с`);
          return undefined;
        }).catch((e: unknown) => {
          conflicts.push(`${m.name}: ${e instanceof Refusal ? `${e.word}${e.why ? ` — ${e.why}` : ""}` : errFields(e).why}`);
          return undefined;
        }),
      ),
    );
    live.forEach((m, i) => {
      const part = got[i];
      if (!part) return;
      const { env: e, mcpServers: servers, settings: st, append: text, hooks: h, defaults, ...rest } = part;
      if (defaults) lower.push(defaults);
      const core = Object.keys(rest).find((k) => CORE_OPTIONS.has(k));
      if (core) return void conflicts.push(`${m.name}: опция ${core} — её держит ядро`);
      claim("env", env, e, m.name);
      claim("сервер инструментов", mcpServers, servers, m.name);
      claim("settings", settings, st, m.name);
      claim("опция", options, rest, m.name);
      if (text) append.push(text);
      for (const [event, matchers] of Object.entries(h ?? {})) (hooks[event] ??= []).push(...matchers);
    });
    for (const d of lower) {
      for (const [k, v] of Object.entries(d.env ?? {})) if (!(k in env)) env[k] = v;
      for (const [k, v] of Object.entries(d.settings ?? {})) if (!(k in settings)) settings[k] = v;
    }
    const all = {
      permissionMode: "bypassPermissions",
      ...options,
      allowDangerouslySkipPermissions: true,
      cwd: s.rec.cwd,
      env: { ...this.env(env), CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1" },
      mcpServers,
      hooks,
      ...(Object.keys(settings).length ? { settings } : {}),
      systemPrompt: { type: "preset", preset: "claude_code", ...(append.length ? { append: append.join("\n\n") } : {}) },
      pathToClaudeCodeExecutable: this.sdk.bin,
      canUseTool: (tool: string, input: Record<string, unknown>, opts: Record<string, unknown>) => this.decide(s, tool, input, opts),
      onElicitation: (request: Record<string, unknown>, opts: { signal: AbortSignal; requestId: string }) => this.elicit(s, request, opts),
    };
    return { options: all, conflicts };
  }

  /** Вклад самого ядра: сервер инструментов флота, промпт, режим и модель из документа. */
  corePart(s: SessionApi): QueryPart {
    const { model, effort, mode, fast, style, thinking } = s.spec;
    const settings = { ...(fast !== undefined ? { fastMode: fast } : {}), ...(style ? { outputStyle: style } : {}), ...(thinking !== undefined ? { alwaysThinkingEnabled: thinking } : {}) };
    return {
      enableFileCheckpointing: true,
      includePartialMessages: true,
      permissionMode: MODES[mode ?? "all"],
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      ...(Object.keys(settings).length ? { settings } : {}),
      mcpServers: { fleet: { type: "http", url: `${this.o.base}/mcp`, headers: { Authorization: `Bearer ${this.o.key}`, "x-sb-as": s.callsign } } },
      append: fleetPrompt(s.callsign),
    };
  }

  private async decide(s: Session, tool: string, input: Record<string, unknown>, opts: Record<string, unknown>): Promise<PermissionResult> {
    const m = this.decider;
    if (!m) return (s.rec.spec.mode ?? "all") === "all" ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: "нет модуля вопросов" };
    const answer = await this.guard(m, "decide", s.callsign, () => m.decide!(s.facade(m), input, { ...opts, tool } as DecideOpts));
    return answer ?? { behavior: "deny", message: "module_failed" };
  }

  private async elicit(s: Session, request: Record<string, unknown>, opts: { signal: AbortSignal; requestId: string }): Promise<unknown> {
    const m = this.eliciter;
    const answer = m ? await this.guard(m, "elicit", s.callsign, () => m.elicit!(s.facade(m), request, opts)) : undefined;
    return answer ?? { action: "decline" };
  }

  // ───────────────────────── старт ─────────────────────────

  /** Только свои переменные: подброшенное на машине не доходит до процессов; папка Claude — своя. */
  private ownEnv(): void {
    const dropped = Object.keys(process.env).filter((k) => OWN_ENV.test(k) && !KEPT_ENV.has(k));
    for (const k of dropped) delete process.env[k];
    if (dropped.length) this.log.info("env_dropped", { why: `стёрто из окружения: ${dropped.join(", ")}` });
    process.env.CLAUDE_CONFIG_DIR = join(this.o.home, "claude");
    mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
  }

  private refuseStart(reasons: string[]): void {
    if (!reasons.length) return;
    for (const why of reasons) this.log.error("gate", { word: "check_failed", why });
    throw new StartError(reasons);
  }

  /** Проверка набора без запуска: пустой список — годен. */
  check(): string[] {
    return this.gate();
  }

  async start(): Promise<void> {
    this.log.info("host_start", { build: this.o.build, sdk: this.version, modules: this.mods.map((m) => m.name) });
    this.ownEnv();
    this.refuseStart(this.gate());
    const files = this.holders.files();
    for (const rec of this.disk.records()) this.sessions.set(rec.callsign, new Session(this, rec));
    for (const m of this.mods) {
      if (!m.start) continue;
      const why = await within<string | null>(this.clock, Promise.resolve().then(() => m.start!(this.hostFacade(m))).then(() => null), MODULE_MS, () => `start не вернулся за ${MODULE_MS / 1000} с`).catch((e: unknown) => errFields(e).why);
      if (why) this.refuseStart([`${m.name}: ${why}`]);
    }
    const live = [...this.sessions.values()].filter((s) => !s.rec.stopped);
    this.connect();
    const work = [
      ...files.filter((f) => !live.some((s) => s.callsign === f.id)).map((f) => this.killOrphan(f)),
      ...live.map((s) => {
        quiet(s.launch(files.some((f) => f.id === s.callsign) ? "attach" : "resume"));
        return s.settled();
      }),
    ];
    await Promise.race([Promise.all(work), new Promise((r) => this.abort.signal.addEventListener("abort", r))]);
    if (this.abort.signal.aborted) return;
    this.log.info("ready", { build: this.o.build });
  }

  /** Процесс, которого нет в списке сессий: kill, старт ждёт его выхода с пределом. */
  private async killOrphan(f: HoldFile): Promise<void> {
    this.log.warn("orphan_kill", { callsign: f.id, why: `процесс ${f.id} (pid ${f.pid}) не в списке сессий — kill` });
    const h = this.holders.connect(f);
    h.destroy();
    await within<unknown>(this.clock, h.exited, KILL_MS, () => this.log.warn("orphan_late", { callsign: f.id, why: `держатель ${f.id} не вышел за ${KILL_MS / 1000} с после kill` }));
    h.detach();
  }

  // ───────────────────────── связь ─────────────────────────

  private connect(): void {
    const { base, fleet, key } = this.o;
    const onFrame = (f: Frame) => this.onFrame(f);
    const onState = (st: LinkState) => this.onLink(st);
    this.link = this.o.connect
      ? this.o.connect({ onFrame, onState })
      : socketLink({ url: `${base.replace(/^http/, "ws")}/m/${fleet}/${this.machine}`, hello: { type: "hello", proto: PROTO, key, role: "host" }, onFrame, onState, stopOn: ["bad_key", "revoked", "forbidden", "proto", "replaced"] });
  }

  private onLink(state: LinkState): void {
    this.linkState = state;
    if (this.shutting) return;
    if (state !== "open") this.accepted = false;
    if (state === "open") {
      this.log.info("link_open");
    } else if (state === "closed") {
      this.log.warn("link_closed");
      for (const [id, done] of [...this.pending]) done(fail(id, "offline", "соединение оборвалось"));
    } else if (state === "stopped") {
      this.log.error("link_stopped", { why: "пропуск машины не принят или этот Host вытеснен другим — Host не переподключается" });
      void this.shutdown("соединение с флотом закрыто без права переподключения");
    }
  }

  /** Кадр в соединение; нет соединения — не уходит: строки сессий уйдут снимком при открытии. */
  send(f: Frame): boolean {
    if (!this.link || !this.accepted) return false;
    this.link.send(f);
    return true;
  }

  private onFrame(f: Frame): void {
    if (isReply(f)) return void this.pending.get(f.id)?.(f);
    if (f.type === "hello.ok") {
      // соединение принято — снимок машины: заменяет её строки в картине
      this.accepted = true;
      this.link!.send({ type: "machine.hello", build: this.o.build, sdk: this.version, os: process.platform, sessions: [...this.sessions.values()].map((s) => s.hello()) });
      return;
    }
    if (f.id) {
      const work = this.serve(f).then((r) => void this.link?.send({ ...r, to: f.from }));
      this.inflight.add(work);
      void work.finally(() => this.inflight.delete(work));
      return;
    }
    const owner = this.frameOwners.get(f.type);
    const handler = owner?.frames?.[f.type];
    if (!handler) return void this.log.warn("frame", { type: f.type, from: f.from, word: "unknown_request", why: `кадр ${f.type}: хозяина нет` });
    if (this.shutting) return;
    this.guard(owner!, `frames.${f.type}`, undefined, () => handler(f, this.ctx(owner!, f)));
  }

  private ctx(m: Module, f: Frame): Ctx {
    return { from: f.from ?? `@${this.machine}`, trace: f.trace, log: this.log.with({ module: m.name, trace: f.trace }), signal: this.abort.signal };
  }

  /** Запрос хозяину на этой машине: из соединения и от модуля — одна дорога. На каждый — строка журнала и отрезок host. */
  async serve(f: Frame): Promise<Reply> {
    const id = f.id ?? newId("r");
    const lap = stopwatch();
    const to = typeof f.to === "string" ? f.to : undefined;
    const done = (r: Reply, module?: string): Reply => {
      const ms = lap();
      const line = { type: f.type, from: f.from, to, ms, ok: r.ok, word: r.error, why: r.why, trace: f.trace, module };
      if (r.ok) this.log.info("request", line);
      else if (r.error === "module_failed") this.log.error("request", line);
      else this.log.warn("request", line);
      return { ...r, ...(f.trace ? { trace: f.trace } : {}), spans: [{ part: "host", ms }] };
    };
    if (this.shutting) return done(fail(id, "shutting_down", "Host останавливается"));
    const def = contract.request(f.type);
    const m = this.requestOwners.get(f.type);
    const handler = m?.requests?.[f.type];
    if (!def || !m || !handler) return done(fail(id, "unknown_request", `${f.type}: такого запроса на этой машине нет`));
    const parsed = def.input.safeParse(f);
    if (!parsed.success) return done(fail(id, "bad_input", `${f.type}: ${parsed.error.issues.map((i) => `${i.path.join(".")} — ${i.message}`).join("; ")}`), m.name);
    if (def.target === "session" && !this.sessions.has(to ?? "")) return done(fail(id, "not_found", `${f.type}: сессии ${String(f.to)} нет на ${this.machine}`), m.name);
    if (def.target === "machine" && machineOf(to ?? "") !== this.machine) return done(fail(id, "not_found", `${f.type}: ${String(f.to)} — не эта машина`), m.name);
    try {
      return done(ok(id, await handler(parsed.data, this.ctx(m, f))), m.name);
    } catch (e) {
      if (e instanceof Refusal) return done(fail(id, e.word, e.why), m.name);
      const { why, stack } = errFields(e);
      this.log.error("module_failed", { module: m.name, type: f.type, trace: f.trace, why, stack });
      return done(fail(id, "module_failed", `${m.name}: ${why}`), m.name);
    }
  }

  /** Запрос договора от ядра и модулей: службе и объекту флота — POST, сессии и машине — у себя или через соединение. */
  async call<I, O>(def: RequestDef<I, O>, input: I, opts: { from?: string; trace?: string } = {}): Promise<O> {
    const trace = opts.trace ?? newId("t");
    if (def.target === "service" || def.target === "fleet") return this.api.call(def, input as never, { trace }) as Promise<O>;
    const f: Frame = { ...(input as object), type: def.name, id: newId("r"), trace, from: opts.from ?? `@${this.machine}` };
    const target = machineOf(String(f.to ?? ""));
    let r: Reply;
    if (def.target !== "keeper" && target === this.machine) r = await this.serve(f);
    else if (!this.send(f)) r = fail(f.id!, "offline", "нет соединения с флотом");
    else {
      r = await within<Reply>(this.clock, new Promise((res) => this.pending.set(f.id!, res)), CALL_MS, () => fail(f.id!, "timeout", `${def.name}: нет ответа за ${CALL_MS / 1000} с`));
      this.pending.delete(f.id!);
    }
    if (!r.ok) throw new Refusal(r.error ?? "module_failed", r.why);
    return r.result as O;
  }

  // ───────────────────────── сессии ─────────────────────────

  /** Ключи документа проверяют их хозяева: негодное значение — отказ словом хозяина. */
  async checkSpec(patch: Record<string, unknown>, s: Session | null): Promise<void> {
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      const owner = this.specOwners.get(key);
      if (!owner) throw new Refusal("bad_spec", `ключ ${key}: хозяина нет на этой машине`);
      await owner.spec![key]!(value, s ? s.facade(owner) : null);
    }
  }

  folder(cwd: string): string {
    const dir = clientPath(cwd, homedir());
    if (!dir) throw new Refusal("bad_dir", `папка ${JSON.stringify(cwd)} не от ~ и не полная`);
    if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) throw new Refusal("bad_dir", `папки ${cwd} нет на ${this.machine}`);
    return dir;
  }

  async open(given: Spec, o: OpenOpts): Promise<Session> {
    if (this.shutting) throw new Refusal("shutting_down");
    const taken = (name: string) => this.sessions.has(`${name}@${this.machine}`) || this.opening.has(`${name}@${this.machine}`);
    let spec = given;
    if (o.number) {
      let n = 1;
      while (taken(`${given.name}-${n}`)) n++;
      spec = { ...given, name: `${given.name}-${n}` };
    }
    const callsign = `${spec.name}@${this.machine}`;
    if (taken(spec.name)) throw new Refusal("name_taken", `${callsign} уже есть`);
    if (o.mkdir) {
      const dir = clientPath(spec.cwd, homedir());
      if (dir) mkdirSync(dir, { recursive: true });
    }
    const cwd = this.folder(spec.cwd);
    const copy = o.fork && o.resume;
    // заголовок до первого слова SDK: из документа, иначе начало первого сообщения
    const title = spec.title ?? (o.prompt ? o.prompt.trim().split(/\r?\n/)[0]!.slice(0, TITLE_MAX) : undefined);
    const rec = { callsign, spec, cwd, sessionId: o.resume && !copy ? o.resume : randomUUID(), sdk: this.version, stopped: false, by: o.by, since: this.clock.now(), ...(copy ? { fork: copy } : {}), ...(title ? { title } : {}) };
    const s = new Session(this, rec);
    let parts: Parts;
    this.opening.add(callsign);
    try {
      await this.checkSpec(spec as Record<string, unknown>, null);
      parts = await this.parts(s);
      if (parts.conflicts.length) throw new Refusal("open_failed", parts.conflicts.join("; "));
    } catch (e) {
      this.disk.dropSession(callsign);
      throw e;
    } finally {
      this.opening.delete(callsign);
    }
    this.sessions.set(callsign, s);
    this.save();
    this.log.info("open", { callsign, cwd, from: o.by });
    s.sync();
    if (o.prompt) s.input(o.prompt, { from: o.by });
    try {
      await s.launch(copy ? "fork" : o.resume ? "resume" : "spawn", parts);
    } catch (e) {
      throw new Refusal("open_failed", errFields(e).why);
    }
    return s;
  }

  /** Сессия убрана: записи и разделов нет, из картины снята. */
  forget(s: Session): void {
    this.sessions.delete(s.callsign);
    this.disk.dropSession(s.callsign);
    this.save();
    this.log.info("remove", { callsign: s.callsign });
    this.send({ type: "session.state", callsign: s.callsign, row: null });
    for (const m of this.mods) this.guard(m, "on.removed", s.callsign, () => m.on?.removed?.(s.callsign));
  }

  // ───────────────────────── Host глазами модуля ─────────────────────────

  private probe(o: { env?: Record<string, string> } = {}) {
    let finish = () => {};
    const closed = new Promise<void>((r) => (finish = r));
    const prompt = (async function* () {
      await closed;
    })();
    const q = this.sdk.query({ prompt, options: { env: this.env(o.env), permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true, pathToClaudeCodeExecutable: this.sdk.bin } });
    const probe = {
      sdk: (name: string, ...args: unknown[]) => quiet(Promise.resolve().then(() => q[name](...args))),
      close: () => {
        this.probes.delete(probe);
        finish();
        q.close();
      },
    };
    this.probes.add(probe);
    return probe;
  }

  hostFacade(m: Module): HostApi {
    let host = this.hosts.get(m);
    if (!host) {
      const { home, fleet, base, build, key, config } = this.o;
      host = {
        machine: this.machine,
        fleet,
        base,
        dataDir: home,
        build,
        sdkVersion: this.version,
        key,
        log: this.log.with({ module: m.name }),
        signal: this.abort.signal,
        session: (callsign) => this.sessions.get(callsign)?.facade(m),
        sessions: () => [...this.sessions.values()].map((s) => s.facade(m)),
        open: async (spec, o) => (await this.open(spec, o)).facade(m),
        call: (def, input, o) => this.call(def, input, o) as never,
        emit: (f) => void this.send(f),
        store: <T>() => this.disk.section<T>(m.name),
        config: <T>() => (config?.[m.name] ?? {}) as T,
        cli: (args, o = {}) => this.sdk.cli(args, this.env(o.env), o.input),
        probe: (o) => this.probe(o),
        module: <T>(name: string) => this.mods.find((x) => x.name === name)?.api as T | undefined,
        meter: this.meter,
      };
      this.hosts.set(m, host);
    }
    return host;
  }

  // ───────────────────────── остановка ─────────────────────────

  /** Штатная остановка: повторный сигнал получает ту же. Сессии остаются в держателях. */
  shutdown(why: string): Promise<void> {
    if (!this.shutting) {
      let done = () => {};
      this.shutting = new Promise((r) => (done = r));
      void this.down(why).then(done);
    }
    return this.shutting;
  }

  private async down(why: string): Promise<void> {
    this.log.info("shutdown", { why: `остановка: ${why}` });
    this.abort.abort();
    let waits = "начатые запросы";
    const work = async () => {
      await Promise.allSettled(this.inflight);
      for (const m of [...this.mods].reverse()) {
        if (!m.stop) continue;
        waits = `stop() модуля ${m.name}`;
        await this.guard(m, "stop", undefined, () => m.stop!());
      }
      return 0;
    };
    const code = await within(this.clock, work(), SHUTDOWN_MS, () => {
      this.log.error("shutdown_late", { why: `остановка не успела за ${SHUTDOWN_MS / 1000} с: ждёт ${waits} — жёсткий выход 1 · ${why}` });
      return 1;
    });
    for (const p of [...this.probes]) p.close();
    this.link?.close();
    this.holders.close();
    if (code === 0) this.log.info("exit", { why: `выход 0 · ${why}` });
    this.o.exit?.(code);
  }
}
