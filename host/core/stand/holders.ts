// Поддельные держатели: у каждого поддельного claude — свой TCP на 127.0.0.1 с протоколом держателя (кадры).
// Процесс живёт, пока его не убили: без Host копит вывод и выход и отдаёт их следующему подключению.
import { randomBytes } from "node:crypto";
import net from "node:net";
import { frame, frames } from "../src/holders.ts";
import type { HoldFile, HolderApi } from "../src/holders.ts";
import { lineReader } from "./wire.ts";
import type { Wire } from "./wire.ts";

/** Поддельный процесс claude: ход ведёт тест, сообщения SDK идут через держатель кадрами. */
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
  private holders: FakeHolders;
  readonly key = randomBytes(16).toString("hex");
  port = 0;
  private server: net.Server | null = null;
  /** выход, ещё не отданный Host */
  private exitInfo: { code: number | null; signal: string | null; stderr: string } | null = null;
  private listeners: Array<(w: Wire) => void> = [];

  constructor(k: FakeHolders, id: string, pid: number, o: { command?: string; args?: string[]; cwd?: string; env?: Record<string, string | undefined> } = {}) {
    this.holders = k;
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

  /** Держатель процесса: порт от ОС. */
  async listen(): Promise<this> {
    this.server = net.createServer((sock) => this.accept(sock));
    await new Promise<void>((r) => this.server!.listen(0, "127.0.0.1", r));
    this.port = (this.server.address() as net.AddressInfo).port;
    return this;
  }

  get file(): HoldFile {
    return { id: this.id, owner: "host", pid: this.pid, port: this.port, key: this.key };
  }

  /** Подключение Host: ключ → hello, накопленное, затем живой поток; вышел — выход сразу. */
  private accept(sock: net.Socket): void {
    sock.on("error", () => {});
    let authed = false;
    const lines = lineReader((x: Wire) => this.fromSdk(x));
    sock.on(
      "data",
      frames((t, data) => {
        if (!authed) {
          if (t !== "a" || data.toString("utf8") !== this.key) {
            sock.end(frame("e", "bad_key"));
            return;
          }
          // новый хозяин вытесняет прежнего
          if (this.sock && !this.sock.destroyed) this.sock.destroy();
          authed = true;
          this.holders.ops.push({ op: "attach", id: this.id, buffered: this.buffered });
          this.sock = sock;
          sock.write(frame("h", JSON.stringify({ pid: this.pid, buffered: this.buffered })));
          for (const b of this.out.splice(0)) sock.write(frame("o", b));
          if (this.exitInfo) this.deliverExit();
          return;
        }
        if (t === "i") lines(data);
        else if (t === "c") {
          this.holders.ops.push({ op: "close_input", id: this.id });
          // ввод закрыт — claude выходит сам с кодом 0
          this.exit(0);
        } else if (t === "k") {
          this.holders.ops.push({ op: "kill", id: this.id });
          this.exit(null, "", "SIGKILL");
        }
      }),
    );
    sock.on("close", () => {
      if (this.sock === sock) this.sock = null;
    });
  }

  private deliverExit(): void {
    const sock = this.sock;
    if (!sock || sock.destroyed || !this.exitInfo) return;
    sock.end(frame("x", JSON.stringify(this.exitInfo)));
    this.exitInfo = null;
    this.holders.procs.delete(this.id);
    this.server?.close();
  }

  private write(x: unknown): void {
    if (!this.alive) return;
    const b = Buffer.from(JSON.stringify(x) + "\n");
    if (this.sock && !this.sock.destroyed) this.sock.write(frame("o", b));
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

  /** Процесс вышел: держатель отдаёт остаток вывода и выход; Host нет — хранит выход до подключения. */
  exit(code: number | null = 1, stderr = "", signal: string | null = null): void {
    if (!this.alive) return;
    this.alive = false;
    this.exitInfo = { code, signal, stderr };
    this.deliverExit();
  }

  async close(): Promise<void> {
    this.sock?.destroy();
    if (this.server) await new Promise<void>((r) => this.server!.close(() => r()));
  }
}

/** Поддельные держатели: то, что ядро берёт от ОС. */
export class FakeHolders implements HolderApi {
  procs = new Map<string, FakeProc>();
  /** подключения и кадры Host: attach, close_input, kill */
  ops: Array<Record<string, unknown>> = [];
  /** запуски держателей */
  spawns: Array<{ id: string; command: string; args: string[]; cwd?: string; env?: Record<string, string | undefined> }> = [];
  /** столько следующих spawn — процессы, которые не ответят на initialize */
  failInitNext = 0;
  private pids = 1000;

  async spawn(s: { id: string; cwd?: string; env?: Record<string, string | undefined>; command: string; args: string[] }): Promise<HoldFile> {
    this.spawns.push(s);
    this.ops.push({ op: "spawn", id: s.id });
    if (this.procs.get(s.id)?.alive) throw new Error(`in_use: ${s.id}`);
    const p = await new FakeProc(this, s.id, ++this.pids, s).listen();
    if (this.failInitNext > 0) {
      this.failInitNext--;
      p.failInit = true;
    }
    this.procs.set(s.id, p);
    return p.file;
  }

  files(): HoldFile[] {
    return [...this.procs.values()].map((p) => p.file);
  }

  /** Процесс, оставшийся от прежнего Host. */
  async addProcess(id: string): Promise<FakeProc> {
    const p = await new FakeProc(this, id, ++this.pids).listen();
    this.procs.set(id, p);
    return p;
  }

  async close(): Promise<void> {
    for (const p of this.procs.values()) await p.close();
  }
}
