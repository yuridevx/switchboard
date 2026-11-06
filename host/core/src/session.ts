// Сессия: один разговор и его процесс у держателя. Запуск — значение Run; его конец решает одну ветку: наш close, остановка ОС или сбой.
import type { SDKMessage, SDKUserMessage, SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import type { InputOpts, Session as View, SessionInfo, SessionState, StartKind } from "../contract.ts";
import { within } from "./clock.ts";
import { SESSION_FNS } from "./gate.ts";
import { wholeConversation } from "./history.ts";
import type { Exit, Hold } from "./holders.ts";
import type { Kernel, Mod, Parts } from "./kernel.ts";
import { tildePath } from "./paths.ts";
import type { CoreRecord } from "./store.ts";

const INIT_MS = 60_000; // как initializeTimeoutMs у startup() SDK: у query() своего предела нет
const STEP_MS = 30_000;
const RESTART_MS = 6 * 3_600_000;

const STATES: Record<string, SessionState> = { idle: "idle", running: "busy", requires_action: "waiting" };
const isBusy = (s: unknown) => s === "busy" || s === "waiting";

type Launch = StartKind | "fork";
/** Один запуск процесса. seen — состояние из SDK, пришедшее до готовности. */
type Run = { q: any; hold: Promise<Hold>; done: Promise<Exit>; opened: Promise<void>; ready: boolean; closing: boolean; seen?: SessionState };

const words = (x: Exit) => `код ${x.code}${x.signal ? `, сигнал ${x.signal}` : ""}${x.stderr ? `: ${x.stderr}` : ""}`;

/** Обещание, чей отказ модуль может не ждать: ошибка уже в журнале или идёт своей веткой. */
export const quiet = <T>(p: Promise<T>): Promise<T> => (p.catch(() => {}), p);

export class Session {
  readonly rec: CoreRecord;
  startKind: StartKind;
  state: SessionState;
  model: string | null = null;
  /** модули, выключенные в этой сессии: причина */
  readonly failed = new Map<string, string>();
  private k: Kernel;
  private run: Run | null = null;
  private point?: number;
  private inbox: SDKUserMessage[] = [];
  private wake = () => {};
  /** сбои подряд без готовности */
  private falls: string[] = [];
  private turnEnds: Array<() => void> = [];
  private changed: Array<() => void> = [];
  private sent = "";
  private views = new Map<Mod, View>();

  constructor(k: Kernel, rec: CoreRecord, startKind: StartKind, point?: number) {
    this.k = k;
    this.rec = rec;
    this.startKind = startKind;
    this.point = point;
    this.state = rec.stopped ? "stopped" : "starting";
  }

  get callsign(): string {
    return this.rec.callsign;
  }

  get info(): SessionInfo {
    const { callsign, session_id, cwd, sdk, from, stopped } = this.rec;
    return { callsign, session_id, cwd, sdk, stopped, model: this.model, from: from ?? null, start: this.startKind, ...(this.point !== undefined ? { point: this.point } : {}) };
  }

  /** Сессия глазами модуля. */
  facade(m: Mod): View {
    let view = this.views.get(m);
    if (!view) {
      const self = this;
      view = {
        get info() {
          return self.info;
        },
        get state() {
          return self.state;
        },
        input: (c, o) => self.input(c, o),
        sdk: (name, ...args) => self.call(m, name, args),
        restart: () => quiet(self.restart()),
        stop: () => quiet(self.stop()),
        start: (o) => quiet(self.start(o)),
        remove: () => quiet(self.remove()),
        store: <T>() => self.k.disk.section<T>(m.name, self.callsign),
        field: (name) => self.k.field(m, self, name),
        refresh: () => self.sync(),
      };
      this.views.set(m, view);
    }
    return view;
  }

  // ───────────────────────── запись ─────────────────────────

  /** Запись roster: поля ядра и модулей. Модуль, выключенный здесь, поля не отдаёт. */
  record(): Record<string, unknown> {
    const { callsign, sdk, cwd, from } = this.rec;
    const fields = this.k.fieldsOf(this);
    const failed = { ...this.k.failedOnMachine(), ...Object.fromEntries(this.failed) };
    return { callsign, state: this.state, sdk, dir: tildePath(cwd), ...(from ? { by: from } : {}), ...fields, ...(Object.keys(failed).length ? { failed } : {}) };
  }

  /** Запись для hello: relay получит её при входе. */
  hello(): Record<string, unknown> {
    const r = this.record();
    this.sent = JSON.stringify(r);
    return r;
  }

  /** Запись изменилась — кадр session.state. Не ушёл — уйдёт при следующей разнице или при открытии соединения. */
  sync(): void {
    if (!this.k.relay || this.k.sessions.get(this.callsign) !== this) return;
    const r = this.record();
    const text = JSON.stringify(r);
    if (text !== this.sent && this.k.send({ type: "session.state", ...r } as never)) this.sent = text;
  }

  private setState(state: SessionState): void {
    if (this.state === state) return;
    this.state = state;
    this.rec.state = state;
    this.k.save();
    this.k.each(this, "on.state", (mod, view) => mod.on?.state?.(view, state));
    this.sync();
    for (const f of this.changed.splice(0)) f();
  }

  /** Дождаться, пока сессия выйдет из starting. */
  settled(): Promise<void> {
    return new Promise((resolve) => {
      const check = () => (this.state === "starting" ? this.changed.push(check) : resolve());
      check();
    });
  }

  // ───────────────────────── ввод и вызовы SDK ─────────────────────────

  input(content: SDKUserMessage["message"]["content"], { from, ...o }: InputOpts = {}): void {
    if (from) {
      this.rec.from = from;
      this.k.save();
    }
    this.inbox.push({ type: "user", message: { role: "user", content }, parent_tool_use_id: null, ...o } as SDKUserMessage);
    this.wake();
  }

  /** Ввод запуска: только пока запуск текущий и готов — SDK забирает сообщение и у мёртвого процесса, оно бы пропало. */
  private async *stream(run: Run): AsyncGenerator<SDKUserMessage> {
    await run.opened;
    while (this.run === run && !run.closing) {
      const m = this.inbox.shift();
      if (m) yield m;
      else await new Promise<void>((r) => (this.wake = r));
    }
  }

  private call(m: Mod, name: string, args: unknown[]): Promise<unknown> {
    if (!m.manifest.calls?.includes(name)) return quiet(Promise.reject(this.k.violate(m, `${name} нет в calls`, this)));
    const { session_id: id, cwd: dir } = this.rec;
    const q = this.run?.q;
    if (name === "renameSession" && q) return q.renameSession(args[0], id);
    if (SESSION_FNS.has(name)) {
      const last = args.at(-1);
      const named = typeof last === "object" && last !== null;
      const options = { dir, ...(named ? last : {}) };
      const fn = this.k.sdk.functions;
      return name === "getSessionMessages" ? wholeConversation(fn, id, options) : fn[name](id, ...(named ? args.slice(0, -1) : args), options);
    }
    return q ? q[name](...args) : Promise.reject(new Error("процесс сессии не запущен"));
  }

  // ───────────────────────── запуск ─────────────────────────

  /** Как начать разговор: resume — только если файл уже есть; до первого хода его нет, тогда тот же id заново или снова копия. */
  private async plan(kind: Launch): Promise<{ start: Launch; options: Record<string, unknown> }> {
    const { session_id: id, cwd, fork } = this.rec;
    if (kind === "spawn") return { start: kind, options: { sessionId: id } };
    if (kind === "fork") return { start: kind, options: { resume: fork, forkSession: true, sessionId: id } };
    if (kind === "attach" || (await within(this.k.clock, this.k.sdk.functions.getSessionInfo(id, { dir: cwd }), STEP_MS, () => ({})))) return { start: kind, options: { resume: id } };
    return this.plan(fork ? "fork" : "spawn");
  }

  /** Поднять процесс. Отказ — процесс вышел до готовности; сессия при этом ведёт свой сбой сама. */
  launch(kind: Launch, given?: Parts): Promise<void> {
    return this.k.outside(() => this.boot(kind, given));
  }

  private async boot(kind: Launch, given?: Parts): Promise<void> {
    const { k, rec } = this;
    this.startKind = kind === "fork" ? "resume" : kind;
    this.setState("starting");
    const [parts, plan] = await Promise.all([given ?? k.parts(this), this.plan(kind)]);
    if (this.state !== "starting" || k.shutting) return;
    if (parts.conflicts.length) {
      const why = parts.conflicts.join("; ");
      k.log({ kind: "stop", ev: "session_failed", callsign: this.callsign, why });
      this.setState("failed");
      throw new Error(why);
    }
    if (kind !== "attach") rec.sdk = k.version;
    k.save();
    k.log({ ev: "launch", callsign: this.callsign, start: plan.start, sdk: rec.sdk, session_id: rec.session_id });

    let held!: (h: Hold) => void;
    let open!: () => void;
    const hold = new Promise<Hold>((r) => (held = r));
    const opened = new Promise<void>((r) => (open = r));
    const spawnClaudeCodeProcess = (o: { command: string; args: string[]; cwd?: string; env: Record<string, string | undefined> }) => {
      const h = kind === "attach" ? k.holders.attach(this.callsign) : k.holders.spawn({ id: this.callsign, command: o.command, args: o.args, cwd: o.cwd, env: o.env });
      held(h);
      return h as unknown as SpawnedProcess;
    };
    const run: Run = { q: null, hold, opened, done: null as never, ready: false, closing: false };
    this.run = run;
    try {
      run.q = k.sdk.query({ prompt: this.stream(run), options: k.queryOptions(this, parts, { ...plan.options, spawnClaudeCodeProcess }) });
    } catch (e) {
      // процесса нет и не будет — та же ветка сбоя: файла claude нет в пакете SDK, query() бросает сразу
      const why = (e as Error).message;
      this.ended(run, { code: null, signal: null, stderr: why });
      throw new Error(`${this.callsign}: процесс вышел до initialize — ${why}`);
    }
    const read = (async () => {
      try {
        for await (const m of run.q) this.message(run, m);
      } catch {
        // поток сломался раньше процесса: чистый перезапуск через выход; процесс уже вышел — кадр никуда не идёт
        if (!run.closing) (await hold).destroy();
      }
    })();
    // выход — от держателя, дочитать остаток — не дольше ступени
    run.done = hold.then((h) => h.exited).then(async (x) => (await within(k.clock, read, STEP_MS, () => undefined), x));
    void run.done.then((x) => this.ended(run, x));

    const late = k.clock.setTimeout(() => {
      k.log({ kind: "stop", ev: "initialize_late", callsign: this.callsign, why: `процесс не ответил на initialize за ${INIT_MS / 1000} с — kill` });
      void hold.then((h) => h.destroy());
    }, INIT_MS);
    const ready = await Promise.race([run.q.initializationResult().then(() => true, () => false), run.done.then(() => false)]);
    k.clock.clearTimeout(late);
    if (!ready) {
      open();
      throw new Error(`${this.callsign}: процесс вышел до initialize — ${words(await run.done)}`);
    }
    if (run.closing || this.run !== run) return;
    run.ready = true;
    this.falls = [];
    open();
    this.setState(run.seen ?? (kind === "attach" && isBusy(rec.state) ? rec.state! : "idle"));
    k.each(this, "on.open", (mod, view) => mod.on?.open?.(view));
    if (rec.sdk !== k.version) quiet(this.restart());
  }

  private message(run: Run, m: SDKMessage): void {
    const x = m as { type: string; subtype?: string; state?: string; model?: string; session_id?: string };
    if (x.type === "system" && x.subtype === "init") {
      this.model = x.model!;
      if (x.session_id !== this.rec.session_id) {
        this.rec.session_id = x.session_id!;
        this.k.save();
      }
    }
    if (x.type === "system" && x.subtype === "session_state_changed") {
      run.seen = STATES[x.state!];
      if (run.ready && !run.closing) this.setState(run.seen);
    }
    this.k.each(this, "on.event", (mod, view) => mod.on?.event?.(view, m));
    if (x.type === "result") this.turnEnded();
    this.sync();
  }

  private turnEnded(): void {
    for (const f of this.turnEnds.splice(0)) f();
  }

  /** Дождаться конца хода: true — ход кончился или процесса больше нет, false — предел. */
  private turn(ms: number): Promise<boolean> {
    return within(this.k.clock, new Promise<boolean>((r) => this.turnEnds.push(() => r(true))), ms, () => false);
  }

  private closed(): void {
    this.k.each(this, "on.close", (mod, view) => mod.on?.close?.(view));
  }

  /** Конец запуска. Наш close и уход Host ведут свою ветку сами. */
  private ended(run: Run, x: Exit): void {
    const { k, callsign } = this;
    if (this.run === run) this.run = null;
    this.wake();
    this.turnEnded();
    if (run.closing || k.shutting) return;
    if (x.os_stop) {
      k.log({ ev: "session_os_stop", callsign, why: `остановка ОС: процесс claude вышел, ${words(x)}` });
      this.setState("stopped");
      this.closed();
      return;
    }
    k.log({ kind: "stop", ev: "session_exited", callsign, why: `процесс claude вышел, ${words(x)}` });
    this.closed();
    this.falls.push(words(x));
    if (!run.ready && this.falls.length > 1) {
      k.log({ kind: "stop", ev: "session_failed", callsign, why: `второй сбой до готовности — сессия стоит до session.start: ${this.falls.join(" · ")}` });
      this.falls = [];
      this.setState("failed");
      return;
    }
    quiet(this.launch("resume"));
  }

  // ───────────────────────── остановка ─────────────────────────

  /** Снять процесс ступенями с пределом: прерывание хода, закрытие ввода, «убей». */
  private async shut(run: Run, busy: boolean): Promise<void> {
    const { k, callsign } = this;
    const late = (why: string) => k.log({ kind: "stop", ev: "stop_late", callsign, why });
    run.closing = true;
    this.wake();
    let killing = false;
    if (busy) {
      void Promise.resolve(run.q.interrupt()).catch(() => {});
      killing = !(await this.turn(STEP_MS));
      if (killing) late(`нет итога хода после прерывания за ${STEP_MS / 1000} с — kill`);
    }
    const gone = () => within(k.clock, run.done.then(() => true), STEP_MS, () => false);
    if (!killing) {
      run.q.close();
      killing = !(await gone());
      if (killing) late(`нет выхода процесса после закрытия ввода за ${STEP_MS / 1000} с — kill`);
    }
    if (!killing) return;
    (await run.hold).destroy();
    if (!(await gone())) throw new Error(`${callsign}: процесс не вышел и через ${STEP_MS / 1000} с после kill`);
    run.q.close();
  }

  async stop(): Promise<void> {
    const run = this.run;
    if (!run && this.rec.stopped) return;
    this.rec.stopped = true;
    this.k.save();
    if (run) {
      const busy = isBusy(this.state);
      this.setState("stopping");
      await this.shut(run, busy);
    }
    this.setState("stopped");
    this.k.log({ ev: "stop", callsign: this.callsign });
    if (run) this.closed();
  }

  async start(o: { point?: number } = {}): Promise<void> {
    if (this.run || this.state === "starting") return;
    this.rec.stopped = false;
    this.falls = [];
    this.point = o.point;
    await this.launch(o.point === undefined ? "resume" : "point");
  }

  async restart(): Promise<void> {
    const run = this.run;
    if (!run) return this.state === "starting" ? undefined : this.start();
    if (isBusy(this.state) && !(await this.turn(RESTART_MS))) {
      this.k.log({ kind: "refuse", ev: "restart_late", callsign: this.callsign, why: `ход не кончился за ${RESTART_MS / 3_600_000} ч — перезапуск отменён` });
      return;
    }
    if (this.run !== run || run.closing) return;
    this.k.log({ ev: "restart", callsign: this.callsign });
    await this.shut(run, false);
    this.closed();
    await this.launch("resume");
  }

  async remove(): Promise<void> {
    await this.stop();
    this.k.forget(this);
  }
}
