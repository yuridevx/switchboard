// Поддельный keeper: настоящий TCP на 127.0.0.1 и протокол keeper proto 1, процессы — поддельные claude.
// Процесс живёт, пока его не убили: без Host копит вывод и отдаёт его следующему attach — раньше живого потока.
import { randomBytes } from "node:crypto";
import net from "node:net";
import { lineReader } from "./wire.ts";
import type { Wire } from "./wire.ts";

type Reply = { op: "reply"; ok: boolean; result?: unknown; error?: string };

/** Поддельный процесс claude: ход ведёт тест, сообщения SDK идут через keeper как байты. */
export class FakeProc {
  readonly id: string;
  readonly pid: number;
  readonly command: string;
  readonly args: string[];
  readonly cwd?: string;
  readonly env: Record<string, string | undefined>;
  alive = true;
  /** сколько раз SDK слал initialize: второй и дальше — attach */
  initializes = 0;
  /** события хуков, которые SDK передал в последнем initialize */
  hookEvents: string[] = [];
  /** ввод сессии: сообщения user от SDK */
  inputs: Array<{ message: { content: unknown }; priority?: string; [k: string]: unknown }> = [];
  interrupts = 0;
  /** не отвечать на initialize: процесс выйдет до готовности */
  failInit = false;
  /** состояние хода, как его показал тест: на interrupt процесс сам отдаёт result и idle */
  busy = false;
  sock: net.Socket | null = null;
  private out: Buffer[] = [];
  private asks = new Map<string, { tool: string; input: Record<string, unknown>; resolve: (r: any) => void }>();
  private waits = new Map<string, (r: any) => void>();
  private seq = 0;
  private keeper: FakeKeeper;
  private listeners: Array<(w: Wire) => void> = [];

  constructor(k: FakeKeeper, id: string, pid: number, o: { command?: string; args?: string[]; cwd?: string; env?: Record<string, string | undefined> } = {}) {
    this.keeper = k;
    this.id = id;
    this.pid = pid;
    this.command = o.command ?? "claude";
    this.args = o.args ?? [];
    this.cwd = o.cwd;
    this.env = o.env ?? {};
  }

  get buffered(): number {
    return this.out.reduce((n, b) => n + b.length, 0);
  }

  /** Подключить канал процесса: сначала накопленное, потом живой поток. */
  attach(sock: net.Socket): void {
    this.sock = sock;
    for (const b of this.out.splice(0)) sock.write(b);
    sock.on("data", lineReader((x: Wire) => this.fromSdk(x)));
    sock.on("close", () => {
      if (this.sock === sock) this.sock = null;
    });
  }

  private write(x: unknown): void {
    const b = Buffer.from(JSON.stringify(x) + "\n");
    if (this.sock && !this.sock.destroyed) this.sock.write(b);
    else this.out.push(b);
  }

  private fromSdk(x: Wire): void {
    for (const l of this.listeners) l(x);
    if (x.$ === "initialize") {
      this.initializes++;
      this.hookEvents = x.hooks;
      if (this.failInit) return;
      this.write({ $: "initialized" });
      // ждущие разрешения — заново, с тем же toolUseID (опыт 20)
      for (const [toolUseID, a] of this.asks) this.write({ $: "can_use_tool", tool: a.tool, input: a.input, toolUseID });
    } else if (x.$ === "user") this.inputs.push(x.message as FakeProc["inputs"][number]);
    else if (x.$ === "interrupt") {
      this.interrupts++;
      if (this.busy) {
        this.send({ type: "result", subtype: "error_during_execution", is_error: true, num_turns: 1, total_cost_usd: 0, session_id: "s" });
        this.send({ type: "system", subtype: "session_state_changed", state: "idle", session_id: "s" });
      }
    } else if (x.$ === "permission") {
      const a = this.asks.get(x.toolUseID);
      this.asks.delete(x.toolUseID);
      a?.resolve(x.result);
    } else if (x.$ === "hook_result" || x.$ === "elicit_result") {
      const w = this.waits.get(x.id);
      this.waits.delete(x.id);
      w?.(x.result);
    }
  }

  /** Подождать служебную строку от SDK. */
  next(kind: Wire["$"]): Promise<Wire> {
    return new Promise((res) => {
      const l = (w: Wire) => {
        if (w.$ !== kind) return;
        this.listeners = this.listeners.filter((x) => x !== l);
        res(w);
      };
      this.listeners.push(l);
    });
  }

  /** Сообщение SDK из процесса (system, assistant, result…). */
  send(msg: Record<string, unknown>): void {
    if (msg.type === "system" && msg.subtype === "session_state_changed") this.busy = msg.state !== "idle";
    this.write(msg);
  }

  /** Модель вызвала инструмент, которому нужно разрешение: ответ canUseTool. */
  ask(tool: string, input: Record<string, unknown>, toolUseID = `toolu_${++this.seq}`): Promise<any> {
    return new Promise((resolve) => {
      this.asks.set(toolUseID, { tool, input, resolve });
      this.write({ $: "can_use_tool", tool, input, toolUseID });
    });
  }

  /** Событие хука: ответы всех подходящих хуков. */
  hook(event: string, input: Record<string, unknown>, toolUseID?: string): Promise<unknown[]> {
    const id = `h${++this.seq}`;
    return new Promise((resolve) => {
      this.waits.set(id, resolve);
      this.write({ $: "hook", id, event, input: { hook_event_name: event, ...input }, toolUseID });
    });
  }

  elicit(request: Record<string, unknown>): Promise<any> {
    const id = `e${++this.seq}`;
    return new Promise((resolve) => {
      this.waits.set(id, resolve);
      this.write({ $: "elicit", id, request });
    });
  }

  /** Процесс вышел: keeper отдаёт остаток вывода, закрывает канал, затем exited. */
  exit(code: number | null = 1, stderr = "", signal: string | null = null): void {
    if (!this.alive) return;
    this.alive = false;
    this.keeper.procs.delete(this.id);
    const ev = { op: "exited", id: this.id, pid: this.pid, code, signal, stderr };
    const sock = this.sock;
    if (sock && !sock.destroyed) sock.end(() => this.keeper.event(ev));
    else this.keeper.event(ev);
  }
}

/** Поддельный keeper: порт от ОС, ключ — 32 случайных байта. */
export class FakeKeeper {
  readonly key = randomBytes(32).toString("hex");
  port = 0;
  procs = new Map<string, FakeProc>();
  /** все первые строки и запросы управления */
  ops: Array<Record<string, unknown>> = [];
  readies: string[] = [];
  upgrades: string[] = [];
  /** столько следующих spawn — процессы, которые не ответят на initialize */
  failInitNext = 0;
  /** exited, пока Host нет на связи */
  private held: object[] = [];
  private control: net.Socket | null = null;
  private server: net.Server;
  private pids = 1000;

  constructor() {
    this.server = net.createServer((s) => this.accept(s));
  }

  async listen(): Promise<this> {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.port = (this.server.address() as net.AddressInfo).port;
    return this;
  }

  /** Первая строка ввода Host. */
  line(): string {
    return JSON.stringify({ keeper: `127.0.0.1:${this.port}`, key: this.key });
  }

  get addr() {
    return { host: "127.0.0.1", port: this.port, key: this.key };
  }

  /** Процесс, оставшийся от прежнего Host. */
  addProcess(id: string): FakeProc {
    const p = new FakeProc(this, id, ++this.pids);
    this.procs.set(id, p);
    return p;
  }

  /** stop по управлению: upgrade или machine. */
  stop(reason: string): void {
    this.control?.write(JSON.stringify({ op: "stop", reason }) + "\n");
  }

  get connected(): boolean {
    return !!this.control && !this.control.destroyed;
  }

  event(ev: object): void {
    if (this.connected) this.control!.write(JSON.stringify(ev) + "\n");
    else this.held.push(ev);
  }

  async close(): Promise<void> {
    this.control?.destroy();
    for (const p of this.procs.values()) p.sock?.destroy();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  private accept(sock: net.Socket): void {
    let head: Buffer | null = Buffer.alloc(0);
    sock.on("error", () => {});
    const onData = (b: Buffer) => {
      head = Buffer.concat([head!, b]);
      const i = head.indexOf(10);
      if (i < 0) return;
      const first = JSON.parse(head.subarray(0, i).toString("utf8"));
      const rest = head.subarray(i + 1);
      head = null;
      sock.off("data", onData);
      this.ops.push(first);
      const reply = (r: Reply) => sock.write(JSON.stringify(r) + "\n");
      const refuse = (error: string) => {
        reply({ op: "reply", ok: false, error });
        sock.end();
      };
      if (first.key !== this.key) return refuse("bad_key");
      if (first.proto !== 1) return refuse("contract_mismatch");
      if (first.op === "control") {
        if (this.connected) return refuse("in_use");
        this.control = sock;
        reply({ op: "reply", ok: true, result: { keeper: "stand" } });
        for (const ev of this.held.splice(0)) sock.write(JSON.stringify(ev) + "\n");
        const read = lineReader((x) => this.controlOp(x, reply));
        sock.on("data", read);
        if (rest.length) read(rest);
        return;
      }
      if (first.op === "spawn") {
        if (this.procs.get(first.id)?.alive) return refuse("in_use");
        const p = new FakeProc(this, first.id, ++this.pids, first);
        if (this.failInitNext > 0) {
          this.failInitNext--;
          p.failInit = true;
        }
        this.procs.set(first.id, p);
        reply({ op: "reply", ok: true, result: { pid: p.pid } });
        p.attach(sock);
        if (rest.length) sock.emit("data", rest);
        return;
      }
      if (first.op === "attach") {
        const p = this.procs.get(first.id);
        if (!p) return refuse("unknown_id");
        if (p.sock) return refuse("in_use");
        reply({ op: "reply", ok: true, result: { pid: p.pid, buffered: p.buffered } });
        p.attach(sock);
        if (rest.length) sock.emit("data", rest);
        return;
      }
      refuse("unknown_op");
    };
    sock.on("data", onData);
  }

  private controlOp(x: Record<string, any>, reply: (r: Reply) => void): void {
    this.ops.push(x);
    if (x.op === "list") {
      const processes = [...this.procs.values()].map((p) => ({ id: p.id, pid: p.pid, attached: !!p.sock, buffered: p.buffered }));
      return reply({ op: "reply", ok: true, result: { processes } });
    }
    if (x.op === "kill") {
      const p = this.procs.get(x.id);
      if (!p) return reply({ op: "reply", ok: false, error: "unknown_id" });
      reply({ op: "reply", ok: true });
      // без force keeper закрывает ввод — claude выходит сам с кодом 0; с force — сразу
      return x.force ? p.exit(null, "", "SIGKILL") : p.exit(0);
    }
    if (x.op === "ready") {
      this.readies.push(x.version);
      return reply({ op: "reply", ok: true });
    }
    if (x.op === "upgrade") {
      this.upgrades.push(x.version);
      return reply({ op: "reply", ok: true });
    }
    reply({ op: "reply", ok: false, error: "unknown_op" });
  }
}
