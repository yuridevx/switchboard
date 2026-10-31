// Связь с keeper: TCP на 127.0.0.1, первая строка каждого соединения — { key, proto, op }.
// Соединение управления — строки JSON в обе стороны: на каждый запрос один reply по порядку,
// между ответами — события exited и stop. Соединение процесса — reply, затем сырые байты stream-json.
import { EventEmitter } from "node:events";
import net from "node:net";
import { PassThrough, Writable } from "node:stream";
import type { SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";

export const KEEPER_PROTO = 1;

export type KeeperAddr = { host: string; port: number; key: string };
export type KeeperReply = { op: "reply"; ok: boolean; result?: any; error?: string };
export type Exited = { op: "exited"; id: string; pid?: number; code: number | null; signal?: string | null; stderr?: string };
export type ProcInfo = { id: string; pid: number; attached?: boolean; buffered?: number };

/** Адрес keeper из первой строки ввода Host: { keeper: "127.0.0.1:51873", key }. */
export function parseKeeperLine(line: string): KeeperAddr {
  const x = JSON.parse(line) as { keeper?: string; key?: string };
  if (typeof x.keeper !== "string" || typeof x.key !== "string") throw new Error("строка keeper: нужны keeper и key");
  const i = x.keeper.lastIndexOf(":");
  return { host: x.keeper.slice(0, i), port: Number(x.keeper.slice(i + 1)), key: x.key };
}

/** Разбирает поток на строки JSON. */
function lines(onLine: (x: any) => void): (b: Buffer) => void {
  let buf = "";
  return (b) => {
    buf += b.toString("utf8");
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      const t = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (t) onLine(JSON.parse(t));
    }
  };
}

export class KeeperClient {
  private addr: KeeperAddr;
  private ctl: net.Socket | null = null;
  private waiting: Array<(r: KeeperReply) => void> = [];
  private procs = new Map<string, KeeperProcess>();
  private onExited: (e: Exited) => void;
  private onStop: (reason: string) => void;

  constructor(addr: KeeperAddr, on: { exited: (e: Exited) => void; stop: (reason: string) => void }) {
    this.addr = addr;
    this.onExited = on.exited;
    this.onStop = on.stop;
  }

  /** Соединение управления: первая строка, ответ keeper. Отказ — исключение со словом. */
  async connect(): Promise<void> {
    const sock = net.connect(this.addr.port, this.addr.host);
    this.ctl = sock;
    sock.on("error", () => {});
    sock.on("close", () => {
      for (const w of this.waiting.splice(0)) w({ op: "reply", ok: false, error: "disconnected" });
    });
    sock.on(
      "data",
      lines((x) => {
        if (x.op === "reply") this.waiting.shift()?.(x as KeeperReply);
        else if (x.op === "exited") this.exited(x as Exited);
        else if (x.op === "stop") this.onStop(String(x.reason ?? ""));
      }),
    );
    await new Promise<void>((res, rej) => {
      sock.once("connect", res);
      sock.once("error", rej);
    });
    const r = await this.send({ key: this.addr.key, proto: KEEPER_PROTO, op: "control" });
    if (!r.ok) throw new Error(r.error ?? "keeper отказал");
  }

  /** Запрос по соединению управления; ответы идут по порядку запросов. */
  send(req: Record<string, unknown>): Promise<KeeperReply> {
    if (!this.ctl || this.ctl.destroyed) return Promise.resolve({ op: "reply", ok: false, error: "disconnected" });
    return new Promise((res) => {
      this.waiting.push(res);
      this.ctl!.write(JSON.stringify(req) + "\n");
    });
  }

  async list(): Promise<ProcInfo[]> {
    const r = await this.send({ op: "list" });
    if (!r.ok) throw new Error(`keeper list: ${r.error}`);
    return (r.result?.processes ?? []) as ProcInfo[];
  }

  kill(id: string, force = false): Promise<KeeperReply> {
    return this.send(force ? { op: "kill", id, force: true } : { op: "kill", id });
  }

  private exited(e: Exited): void {
    const p = this.procs.get(e.id);
    if (p) {
      this.procs.delete(e.id);
      p.exit(e);
    }
    this.onExited(e);
  }

  /** Канал процесса для spawnClaudeCodeProcess: spawn нового процесса или attach к живому. */
  channel(op: "spawn" | "attach", id: string, o: SpawnOptions): KeeperProcess {
    const first =
      op === "spawn"
        ? { key: this.addr.key, proto: KEEPER_PROTO, op, id, command: o.command, args: o.args, cwd: o.cwd, env: o.env }
        : { key: this.addr.key, proto: KEEPER_PROTO, op, id };
    const p = new KeeperProcess(net.connect(this.addr.port, this.addr.host), first, this, id);
    this.procs.set(id, p);
    return p;
  }

  /** Отказ в первой строке канала процесса — как выход процесса: ядро поднимет сессию по своим правилам. */
  refused(p: KeeperProcess, id: string, error: string): void {
    if (this.procs.get(id) !== p) return;
    this.exited({ op: "exited", id, code: null, signal: null, stderr: `keeper: ${error}` });
  }

  /** Выход Host: сокеты закрыты, kill не послан — keeper держит процессы и копит вывод. */
  close(): void {
    for (const p of this.procs.values()) p.detach();
    this.procs.clear();
    this.ctl?.destroy();
    this.ctl = null;
  }
}

/** Процесс claude у keeper глазами SDK. stdin.end() → kill по управлению; kill(signal) → kill с force. */
export class KeeperProcess extends EventEmitter implements SpawnedProcess {
  stdin: Writable;
  stdout = new PassThrough();
  killed = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  pid: number | null = null;
  private done = false;
  private finished = false;
  private sockClosed = false;
  private exitInfo: Exited | null = null;
  private sock: net.Socket;
  private keeper: KeeperClient;
  readonly id: string;

  constructor(sock: net.Socket, first: object, keeper: KeeperClient, id: string) {
    super();
    this.sock = sock;
    this.keeper = keeper;
    this.id = id;
    let head: Buffer | null = Buffer.alloc(0);
    sock.on("error", () => {});
    sock.write(JSON.stringify(first) + "\n");
    sock.on("data", (b: Buffer) => {
      if (!head) {
        if (!this.stdout.writableEnded) this.stdout.write(b);
        return;
      }
      head = Buffer.concat([head, b]);
      const i = head.indexOf(10);
      if (i < 0) return;
      const r = JSON.parse(head.subarray(0, i).toString("utf8")) as KeeperReply;
      const rest = head.subarray(i + 1);
      head = null;
      if (!r.ok) {
        keeper.refused(this, id, r.error ?? "отказ");
        return;
      }
      this.pid = r.result?.pid ?? null;
      if (rest.length) this.stdout.write(rest);
    });
    // keeper сначала отдаёт весь вывод и закрывает канал, потом шлёт exited по управлению:
    // выход процесса — когда пришло и то и другое
    // keeper полузакрывает канал (FIN) после всего вывода — закрываем свою сторону
    sock.on("end", () => sock.end());
    sock.on("close", () => {
      this.sockClosed = true;
      this.finish();
    });
    this.stdin = new Writable({
      write: (chunk, _enc, cb) => {
        if (this.done || sock.destroyed) return cb();
        sock.write(chunk, () => cb());
      },
      final: (cb) => {
        // SDK закрывает ввод в close(): keeper закрывает ввод claude, процесс выходит сам
        if (!this.done) void keeper.kill(id);
        cb();
      },
    });
    this.stdin.on("error", () => {});
  }

  /** SDK зовёт kill после ~2 с ожидания конца ввода: процесс и потомки — сразу. */
  kill(_signal: NodeJS.Signals): boolean {
    this.killed = true;
    if (!this.done) void this.keeper.kill(this.id, true);
    return true;
  }

  /** exited от keeper. */
  exit(e: Exited): void {
    this.exitInfo = e;
    this.done = true;
    this.finish();
  }

  private finish(): void {
    const e = this.exitInfo;
    if (this.finished || !e || !this.sockClosed) return;
    this.finished = true;
    this.exitCode = e.code;
    this.signalCode = (e.signal ?? null) as NodeJS.Signals | null;
    if (!this.stdout.writableEnded) this.stdout.end();
    this.emit("exit", e.code, this.signalCode);
  }

  /** Выход Host: соединение закрыто без kill. */
  detach(): void {
    this.done = true;
    this.sock.destroy();
  }
}
