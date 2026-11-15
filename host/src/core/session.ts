import { randomUUID } from "node:crypto";
// Сессия: один разговор и его процесс у держателя. Запуск — значение Run; его конец решает одну ветку: наш close, остановка ОС или сбой.
import { existsSync } from "node:fs";
import { catalogModel, incidentRaise, type SessionRow, type SessionState } from "@sb/protocol";
import { within } from "./clock.ts";
import type { InputOpts, Module, QueryPart, SessionApi } from "./contract.ts";
import { wholeConversation } from "./history.ts";
import type { Exit, Hold } from "./holders.ts";
import type { Kernel } from "./kernel.ts";
import type { CoreRecord } from "./store.ts";

const INIT_MS = 60_000; // как initializeTimeoutMs у startup() SDK: у query() своего предела нет
const STEP_MS = 30_000;
const RESTART_MS = 6 * 3_600_000;
/** Срок кэша разговора: часовой и пятиминутный. */
const CACHE_HOUR_MS = 3_600_000, CACHE_SHORT_MS = 300_000;
/** Сжатие при простое: 54-я минута после последнего ответа — 90 % часа кэша; разговор от 200 К токенов. */
const COMPACT_AFTER_MS = 54 * 60_000, COMPACT_FROM = 200_000;
/** Вид обращения в «Инциденты»: ответила не та модель. */
const MODEL_INCIDENT = "model";
/** Имя модели у записи, которую процесс написал сам (ошибка API, прерывание): модель её не давала. */
const SYNTHETIC = "<synthetic>";
type Usage = { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number; cache_creation?: { ephemeral_1h_input_tokens?: number; ephemeral_5m_input_tokens?: number } };

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
  private k: Kernel;
  private run: Run | null = null;
  private inbox: any[] = [];
  private wake = () => {};
  /** как поднят нынешний процесс */
  launched: Launch | undefined;
  /** сколько раз просили перезапуск живого процесса: документ вступит в силу после хода */
  restarts = 0;
  /** в последнем ходе модель ответила: только такой ход двигает «закончила … назад», непрочитанное и зов человека */
  answered = false;
  /** таймер сжатия при простое и его час */
  private compact: { timer: unknown; at: number } | null = null;
  /** о пропущенном сроке сжатия журнал уже сказал */
  private late = false;
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
          return { sessionId, cwd, by, since, last, model: self.model, queue: self.inbox.length, launch: self.launched, answered: self.answered, ...(self.rec.cache ? { warm: self.warmUntil() } : {}), ...(self.rec.error ? { error: self.rec.error } : {}) };
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
    const { callsign, spec, by, since, last, error, title, cache, answers } = this.rec;
    // ведущий пары — тот, у кого эта сессия записана ведомым
    const lead = [...this.k.sessions.values()].find((x) => x.rec.spec.wing === callsign)?.callsign;
    return {
      callsign, state: this.state, spec, by, since, ...(last ? { last } : {}), ...(title ? { title } : {}), ...(lead ? { lead } : {}), ...(error && this.state === "failed" ? { error } : {}),
      // итог, а не правило: час кэша и час, когда машина сожмёт разговор сама; модель, которая ответила вместо названной
      ...(cache ? { cache: { until: this.warmUntil(), ...(this.compact ? { compact: this.compact.at } : {}), size: cache.size } } : {}), ...(answers ? { answers } : {}),
      ...this.k.rowsOf(this),
    };
  }

  /** До какого времени кэш разговора тёплый. */
  warmUntil(): number {
    const c = this.rec.cache!;
    return c.at + (c.hour ? CACHE_HOUR_MS : CACHE_SHORT_MS);
  }

  // ───────────────────────── ответ модели: кэш, сжатие при простое, сверка модели ─────────────────────────

  /** Ответ модели в основном разговоре: размер разговора и час кэша — в запись сессии; модель ответа сверяется с документом. */
  private said(m: { message?: { model?: string; usage?: Usage } }): void {
    this.answered = true;
    const u = m.message?.usage;
    if (u) {
      const made = u.cache_creation;
      const hour = (made?.ephemeral_1h_input_tokens ?? 0) > 0 ? true : (made?.ephemeral_5m_input_tokens ?? 0) > 0 ? false : (this.rec.cache?.hour ?? false);
      // запись уйдёт на диск с концом хода: на каждый ответ диск не пишется
      this.rec.cache = { at: this.k.clock.now(), size: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), hour };
    }
    const model = m.message?.model;
    const named = this.rec.spec.model;
    if (!model || model === SYNTHETIC || !named) return;
    const other = model === catalogModel(named) ? undefined : model;
    if (other === this.rec.answers) return;
    this.rec.answers = other;
    this.k.save();
    this.sync();
    if (!other) return;
    // система ловит, агент чинит: строка журнала и обращение в «Инциденты»; сама сессия модель не меняет
    const why = `${this.callsign}: в документе модель ${named}, ответила ${other}`;
    this.k.log.error("model_drift", { callsign: this.callsign, word: "model_drift", why });
    quiet(this.k.call(incidentRaise, { to: `@${this.k.machine}`, kind: MODEL_INCIDENT, key: this.callsign, text: why }).catch((e: unknown) => this.k.log.warn("incident", { callsign: this.callsign, why: `обращение «модель» не открыто: ${(e as Error).message}` })));
  }

  /** Сжатие при простое: сессия свободна, кэш часовой и тёплый, разговор от 200 К — на 54-й минуте после ответа уходит «/compact», тем же вводом, что у человека.
   *  Срок прошёл (машина стояла) — строка журнала, догоняющего сжатия нет. Любой новый ход таймер снимает. */
  private arm(): void {
    this.disarm();
    const c = this.rec.cache;
    if (this.state !== "idle" || !c || !c.hour || c.size < COMPACT_FROM) return;
    const at = c.at + COMPACT_AFTER_MS, now = this.k.clock.now();
    if (at <= now) {
      // строка — один раз: пока кэш ещё мог быть тёплым или только что остыл
      if (!this.late) this.k.log.info("idle_compact_late", { callsign: this.callsign, size: c.size, why: `сжатие при простое: срок прошёл ${Math.round((now - at) / 60_000)} мин назад — разговор не сжат` });
      this.late = true;
      return;
    }
    this.late = false;
    const timer = this.k.clock.setTimeout(() => {
      this.compact = null;
      if (this.state !== "idle" || this.k.shutting) return;
      this.k.log.info("idle_compact", { callsign: this.callsign, size: c.size, why: `сжатие при простое: разговор ${Math.round(c.size / 1000)} К, кэш тёплый` });
      this.input("/compact", { priority: "next" });
      this.sync();
    }, at - now);
    this.compact = { timer, at };
  }

  private disarm(): void {
    if (this.compact) this.k.clock.clearTimeout(this.compact.timer);
    this.compact = null;
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
    // «закончила … назад» двигает только ход, где модель ответила
    if (state === "idle" && isBusy(was) && this.answered) this.rec.last = this.k.clock.now();
    if (isBusy(state) && !isBusy(was)) this.answered = false;
    this.arm();
    this.k.save();
    this.k.each(this, "on.state", (mod, view) => mod.on?.state?.(view, state, was));
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

  input(content: unknown, o: InputOpts = {}): void {
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
      if (name !== "getSessionMessages") return fn[name]!(id, ...(named ? args.slice(0, -1) : args), options);
      // после отката и до первого нового сообщения файл разговора ещё хранит ушедшее: SDK обрезает его при запуске, здесь — тем же номером
      const upto = this.rec.upto;
      return wholeConversation(fn, id, options).then((all) => {
        const at = upto && Array.isArray(all) ? all.findIndex((m: { uuid?: string }) => m.uuid === upto) : -1;
        return at < 0 ? all : (all as unknown[]).slice(0, at + 1);
      });
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
    if (kind === "attach" || (await within(this.k.clock, this.k.sdk.functions.getSessionInfo!(id), STEP_MS, () => undefined))) return { start: kind, options: { resume: id, ...(kind !== "attach" && this.rec.upto ? { resumeSessionAt: this.rec.upto } : {}) } };
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
        this.rec.upto = undefined;
        this.k.save();
        // у работающего процесса разговор стал другим (/clear): ленте об этом говорит ядро — SDK своим событием говорит не всегда
        if (run.ready) this.tell({ type: "conversation_reset", uuid: randomUUID(), new_conversation_id: m.session_id });
      }
    }
    // то же событием самого SDK: о разговоре, который ядро уже знает, второй раз не говорим
    if (m.type === "conversation_reset" && typeof m.new_conversation_id === "string") {
      if (m.new_conversation_id === this.rec.sessionId) return;
      this.rec.sessionId = m.new_conversation_id;
      this.rec.upto = undefined;
      this.k.save();
    }
    // после отката разговор пошёл дальше: новая ветка — последняя, обрезать при запуске больше нечего
    if (this.rec.upto && (m.type === "assistant" || m.type === "user") && !m.isReplay) {
      this.rec.upto = undefined;
      this.k.save();
    }
    if (m.type === "assistant" && !m.parent_tool_use_id && !m.isReplay) this.said(m);
    // разговор сжат: кэш написан заново, размер — после сжатия
    if (m.type === "system" && m.subtype === "compact_boundary" && this.rec.cache) {
      const meta = (m.compact_metadata ?? m.compactMetadata ?? {}) as { post_tokens?: number; postTokens?: number };
      this.rec.cache = { ...this.rec.cache, at: this.k.clock.now(), size: meta.post_tokens ?? meta.postTokens ?? 0 };
    }
    if (m.type === "result") {
      // итог с текстом — тоже ответ модели; у хода сжатия и команд итог пустой
      if (typeof m.result === "string" && m.result) this.answered = true;
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

  /** Прервать идущий ход и дождаться его конца; false — не кончился за предел ступени. */
  async halt(): Promise<boolean> {
    const run = this.run;
    if (!run || !isBusy(this.state)) return true;
    const ended = this.turn(STEP_MS);
    void Promise.resolve(run.q.interrupt()).catch(() => {});
    return ended;
  }

  /** Откат разговора до записи at включительно: процесс снимается и поднимается на том же разговоре — его обрезает SDK при запуске.
   *  Ход уже прерван halt(): итог хода пришёл, а состояние idle может прийти следующим сообщением — второго прерывания нет. */
  async rewind(at: string): Promise<void> {
    const run = this.run;
    this.rec.upto = at;
    this.k.save();
    // ждавшие сообщения были к разговору, которого больше нет
    this.inbox.length = 0;
    if (run) await this.shut(run, false);
    await this.launch("resume");
  }

  /** Событие ядра в ленту сессии — той же дорогой, что события процесса. */
  tell(m: Record<string, unknown>): void {
    this.k.each(this, "on.event", (mod, view) => mod.on?.event?.(view, m));
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
