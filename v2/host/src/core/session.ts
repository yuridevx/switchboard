// Сессия: один разговор и его процесс у держателя. Запуск — значение Run; его конец решает одну ветку: наш close, остановка ОС или сбой.
import { existsSync } from "node:fs";
import type { SessionRow, SessionState } from "@sb/protocol";
import { within } from "./clock.ts";
import type { InputOpts, Module, QueryPart, SessionApi } from "./contract.ts";
import { wholeConversation } from "./history.ts";
import type { Exit, Hold } from "./holders.ts";
import type { Kernel } from "./kernel.ts";
import type { CoreRecord } from "./store.ts";

const INIT_MS = 60_000; // как initializeTimeoutMs у startup() SDK: у query() своего предела нет
const STEP_MS = 30_000;
const RESTART_MS = 6 * 3_600_000;

const STATES: Record<string, SessionState> = { idle: "idle", running: "busy", requires_action: "waiting" };
const isBusy = (s: unknown) => s === "busy" || s === "waiting";
/** Функции SDK о разговоре: id сессии и папку подставляет ядро. */
const SESSION_FNS = new Set(["getSessionInfo", "getSessionMessages", "renameSession", "tagSession", "forkSession", "deleteSession", "listSubagents", "getSubagentMessages"]);

export type Launch = "spawn" | "resume" | "attach" | "fork";
/** Один запуск процесса. seen — состояние из SDK, пришедшее до готовности. */
type Run = { q: any; hold: Promise<Hold>; done: Promise<Exit>; opened: Promise<void>; ready: boolean; closing: boolean; seen?: SessionState };
export type Parts = { options: Record<string, unknown>; conflicts: string[] };

const words = (x: Exit) => `код ${x.code}${x.signal ? `, сигнал ${x.signal}` : ""}${x.stderr ? `: ${x.stderr}` : ""}`;

/** Обещание, чей отказ вызывающий может не ждать: ошибка уже в журнале или идёт своей веткой. */
export const quiet = <T>(p: Promise<T>): Promise<T> => (p.catch(() => {}), p);

export class Session {
  readonly rec: CoreRecord;
  state: SessionState;
  model: string | null = null;
  /** текст итога последнего хода */
  result = "";
  /** кто прислал последний ввод: итог хода, начатого родителем, уходит ему */
  turnBy: string | undefined;
  private k: Kernel;
  private run: Run | null = null;
  private inbox: any[] = [];
  private wake = () => {};
  /** как поднят нынешний процесс */
  launched: Launch | undefined;
  /** сколько раз просили перезапуск живого процесса: документ вступит в силу после хода */
  restarts = 0;
  /** сбои подряд без готовности */
  private falls: string[] = [];
  private turnEnds: Array<() => void> = [];
  private changed: Array<() => void> = [];
  private sent = "";
  private views = new Map<Module, SessionApi>();

  constructor(k: Kernel, rec: CoreRecord) {
    this.k = k;
    this.rec = rec;
    this.state = rec.stopped ? "stopped" : "starting";
  }

  get callsign(): string {
    return this.rec.callsign;
  }

  /** Сессия глазами модуля. */
  facade(m: Module): SessionApi {
    let view = this.views.get(m);
    if (!view) {
      const self = this;
      view = {
        callsign: self.callsign,
        get spec() {
          return self.rec.spec;
        },
        get state() {
          return self.state;
        },
        get info() {
          const { sessionId, cwd, by, since, last } = self.rec;
          return { sessionId, cwd, by, since, last, model: self.model, queue: self.inbox.length, launch: self.launched };
        },
        input: (c, o) => self.input(c, o),
        sdk: (name, ...args) => self.call(name, args),
        restart: () => quiet(self.restart()),
        stop: () => quiet(self.stop()),
        start: () => quiet(self.start()),
        remove: () => quiet(self.remove()),
        store: <T>() => self.k.disk.section<T>(m.name, self.callsign),
        sync: () => self.sync(),
      };
      this.views.set(m, view);
    }
    return view;
  }

  // ───────────────────────── строка ─────────────────────────

  /** Строка сессии в картине: поля ядра и вклады модулей. */
  row(): SessionRow {
    const { callsign, spec, by, since, last, error, title } = this.rec;
    // ведущий пары — тот, у кого эта сессия записана ведомым
    const lead = [...this.k.sessions.values()].find((x) => x.rec.spec.wing === callsign)?.callsign;
    return { callsign, state: this.state, spec, by, since, ...(last ? { last } : {}), ...(title ? { title } : {}), ...(lead ? { lead } : {}), ...(error && this.state === "failed" ? { error } : {}), ...this.k.rowsOf(this) };
  }

  /** Строка для снимка machine.hello. */
  hello(): SessionRow {
    const r = this.row();
    this.sent = JSON.stringify(r);
    return r;
  }

  /** Строка изменилась — кадр session.state. Не ушёл — уйдёт снимком при открытии соединения. */
  sync(): void {
    if (this.k.sessions.get(this.callsign) !== this) return;
    const r = this.row();
    const text = JSON.stringify(r);
    if (text === this.sent) return;
    this.sent = text;
    this.k.send({ type: "session.state", callsign: this.callsign, row: r });
  }

  private setState(state: SessionState, error?: string): void {
    if (this.state === state) return;
    const was = this.state;
    this.state = state;
    this.rec.state = state;
    this.rec.error = state === "failed" ? error : undefined;
    if (state === "idle" && isBusy(was)) this.rec.last = this.k.clock.now();
    this.k.save();
    this.k.each(this, "on.state", (mod, view) => mod.on?.state?.(view, state, was));
    this.k.stateChanged(this, state, was);
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

  input(content: unknown, { from, ...o }: InputOpts = {}): void {
    if (from) this.turnBy = from;
    this.inbox.push({ type: "user", message: { role: "user", content }, parent_tool_use_id: null, ...o });
    this.wake();
  }

  /** Ввод запуска: только пока запуск текущий и готов — SDK забирает сообщение и у мёртвого процесса, оно бы пропало. */
  private async *stream(run: Run): AsyncGenerator<unknown> {
    await run.opened;
    while (this.run === run && !run.closing) {
      const m = this.inbox.shift();
      if (m) yield m;
      else await new Promise<void>((r) => (this.wake = r));
    }
  }

  call(name: string, args: unknown[]): Promise<unknown> {
    const { sessionId: id, cwd: dir } = this.rec;
    const q = this.run?.q;
    if (name === "renameSession" && q) return q.renameSession(args[0], id);
    if (SESSION_FNS.has(name)) {
      const last = args.at(-1);
      const named = typeof last === "object" && last !== null;
      const options = { dir, ...(named ? last : {}) };
      const fn = this.k.sdk.functions;
      return name === "getSessionMessages" ? wholeConversation(fn, id, options) : fn[name]!(id, ...(named ? args.slice(0, -1) : args), options);
    }
    return q ? q[name](...args) : Promise.reject(new Error("процесс сессии не запущен"));
  }

  get live(): boolean {
    return this.state === "idle" || this.state === "busy" || this.state === "waiting";
  }

  // ───────────────────────── запуск ─────────────────────────

  /** Как начать разговор: resume — только если файл уже есть; до первого хода его нет, тогда тот же id заново или снова копия. */
  private async plan(kind: Launch): Promise<{ start: Launch; options: Record<string, unknown> }> {
    const { sessionId: id, fork } = this.rec;
    if (kind === "spawn") return { start: kind, options: { sessionId: id, ...(this.rec.title ? { title: this.rec.title } : {}) } };
    if (kind === "fork") return { start: kind, options: { resume: fork, forkSession: true, sessionId: id } };
    if (kind === "attach" || (await within(this.k.clock, this.k.sdk.functions.getSessionInfo!(id), STEP_MS, () => undefined))) return { start: kind, options: { resume: id } };
    return this.plan(fork ? "fork" : "spawn");
  }

  /** Поднять процесс. Отказ — процесс вышел до готовности; сессия при этом ведёт свой сбой сама. */
  async launch(kind: Launch, given?: Parts): Promise<void> {
    const { k, rec } = this;
    this.setState("starting");
    const [parts, plan] = await Promise.all([given ?? k.parts(this), this.plan(kind)]);
    if (this.state !== "starting" || k.shutting) return;
    if (parts.conflicts.length) {
      const why = parts.conflicts.join("; ");
      k.log.error("session_failed", { callsign: this.callsign, why });
      this.setState("failed", why);
      throw new Error(why);
    }
    if (kind !== "attach") rec.sdk = k.version;
    k.save();
    this.launched = plan.start;
    k.log.info("launch", { callsign: this.callsign, start: plan.start, sdk: rec.sdk, sessionId: rec.sessionId });

    let held!: (h: Hold) => void;
    let open!: () => void;
    const hold = new Promise<Hold>((r) => (held = r));
    const opened = new Promise<void>((r) => (open = r));
    const spawnClaudeCodeProcess = (o: { command: string; args: string[]; cwd?: string; env: Record<string, string | undefined> }) => {
      const h = kind === "attach" ? k.holders.attach(this.callsign) : k.holders.spawn({ id: this.callsign, command: o.command, args: o.args, cwd: o.cwd, env: o.env });
      held(h);
      return h as unknown;
    };
    const run: Run = { q: null, hold, opened, done: null as never, ready: false, closing: false };
    this.run = run;
    try {
      run.q = k.sdk.query({ prompt: this.stream(run), options: { ...parts.options, ...plan.options, spawnClaudeCodeProcess } });
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
        // поток сломался раньше процесса: чистый перезапуск через выход
        if (!run.closing) (await hold).destroy();
      }
    })();
    // выход — от держателя, дочитать остаток — не дольше ступени
    run.done = hold.then((h) => h.exited).then(async (x) => (await within(k.clock, read, STEP_MS, () => undefined), x));
    void run.done.then((x) => this.ended(run, x));

    const late = k.clock.setTimeout(() => {
      k.log.error("initialize_late", { callsign: this.callsign, why: `процесс не ответил на initialize за ${INIT_MS / 1000} с — kill` });
      void hold.then((h) => h.destroy());
    }, INIT_MS);
    const ready = await Promise.race([run.q.initializationResult().then(() => true, () => false), run.done.then(() => false)]);
    k.clock.clearTimeout(late);
    if (!ready) {
      // initialize отказан, а процесс жив: claude ждёт дальше сам. Ввод открыт после выхода: иначе его заберёт уходящий процесс
      void hold.then((h) => h.destroy());
      const x = await within<Exit>(k.clock, run.done, STEP_MS, () => ({ code: null, signal: null, stderr: `процесс не вышел за ${STEP_MS / 1000} с после kill` }));
      open();
      throw new Error(`${this.callsign}: процесс вышел до initialize — ${words(x)}`);
    }
    if (run.closing || this.run !== run) return;
    if (kind === "attach" && rec.sdk === k.version) {
      await this.fit(run, (parts.options.mcpServers ?? {}) as Record<string, unknown>);
      if (run.closing || this.run !== run) return;
    }
    run.ready = true;
    this.falls = [];
    open();
    this.setState(run.seen ?? (kind === "attach" && isBusy(rec.state) ? rec.state! : "idle"));
    if (rec.sdk !== k.version) quiet(this.restart());
  }

  /** Процесс пережил подмену Host: набор серверов инструментов — как у нового Host. Сбой — журнал, сессия работает дальше. */
  private async fit(run: Run, servers: Record<string, unknown>): Promise<void> {
    const { k, callsign } = this;
    const stuck = (why: string) => k.log.warn("fit", { callsign, why: `серверы инструментов не обновлены: ${why}` });
    const work = async () => {
      const { errors = {} } = ((await run.q.setMcpServers(servers)) ?? {}) as { errors?: Record<string, string> };
      if (Object.keys(errors).length) stuck(JSON.stringify(errors));
    };
    await within<void>(k.clock, work(), STEP_MS, () => stuck(`нет ответа за ${STEP_MS / 1000} с`)).catch((e: Error) => stuck(e.message));
  }

  private message(run: Run, m: any): void {
    if (m.type === "system" && m.subtype === "init") {
      this.model = m.model ?? null;
      if (m.session_id && m.session_id !== this.rec.sessionId) {
        this.rec.sessionId = m.session_id;
        this.k.save();
      }
    }
    if (m.type === "result") {
      if (typeof m.result === "string") this.result = m.result;
      this.turnEnded();
    }
    this.k.each(this, "on.event", (mod, view) => mod.on?.event?.(view, m));
    if (m.type === "system" && m.subtype === "session_state_changed") {
      run.seen = STATES[m.state];
      if (run.ready && !run.closing && run.seen) this.setState(run.seen);
    }
  }

  private turnEnded(): void {
    for (const f of this.turnEnds.splice(0)) f();
  }

  /** Дождаться конца хода: true — ход кончился или процесса больше нет, false — предел. */
  private turn(ms: number): Promise<boolean> {
    return within(this.k.clock, new Promise<boolean>((r) => this.turnEnds.push(() => r(true))), ms, () => false);
  }

  /** Конец запуска. Наш close и уход Host ведут свою ветку сами. */
  private ended(run: Run, x: Exit): void {
    const { k, callsign } = this;
    if (this.run === run) this.run = null;
    this.wake();
    this.turnEnded();
    if (run.closing || k.shutting) return;
    if (x.os_stop) {
      k.log.info("session_os_stop", { callsign, why: `остановка ОС: процесс claude вышел, ${words(x)}` });
      this.setState("stopped");
      return;
    }
    k.log.warn("session_exited", { callsign, why: `процесс claude вышел, ${words(x)}` });
    k.meter.count("session.crash");
    // процесс не запустился, потому что папки сессии больше нет: вторая попытка ничего не даст — причина прямо в строке
    if (/no such file or directory|ENOENT|cannot find the path/i.test(words(x)) && !existsSync(this.rec.cwd)) {
      const why = `папки сессии нет: ${this.rec.cwd}`;
      k.log.error("session_failed", { callsign, why });
      this.falls = [];
      this.setState("failed", why);
      return;
    }
    this.falls.push(words(x));
    if (!run.ready && this.falls.length > 1) {
      const why = `второй сбой до готовности: ${this.falls.join(" · ")}`;
      k.log.error("session_failed", { callsign, why });
      this.falls = [];
      this.setState("failed", why);
      return;
    }
    k.meter.count("session.resume");
    quiet(this.launch("resume"));
  }

  // ───────────────────────── остановка ─────────────────────────

  /** Снять процесс ступенями с пределом: прерывание хода, закрытие ввода, «убей». */
  private async shut(run: Run, busy: boolean): Promise<void> {
    const { k, callsign } = this;
    const late = (why: string) => k.log.warn("stop_late", { callsign, why });
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
    this.k.log.info("stop", { callsign: this.callsign });
  }

  async start(): Promise<void> {
    if (this.run || this.state === "starting") return;
    this.rec.stopped = false;
    this.falls = [];
    await this.launch("resume");
  }

  /** Перезапуск процесса после хода: новый документ или новый SDK вступают в силу. */
  async restart(): Promise<void> {
    const run = this.run;
    if (!run) return this.state === "starting" ? undefined : this.start();
    this.restarts++;
    if (isBusy(this.state) && !(await this.turn(RESTART_MS))) {
      this.k.log.warn("restart_late", { callsign: this.callsign, why: `ход не кончился за ${RESTART_MS / 3_600_000} ч — перезапуск отменён` });
      return;
    }
    if (this.run !== run || run.closing) return;
    this.k.log.info("restart", { callsign: this.callsign });
    await this.shut(run, false);
    await this.launch("resume");
  }

  async remove(): Promise<void> {
    await this.stop();
    this.k.forget(this);
  }

  /** Host уходит: соединение с держателем снимается ядром, процесс живёт. */
  get running(): boolean {
    return !!this.run;
  }
}

export type { QueryPart };
