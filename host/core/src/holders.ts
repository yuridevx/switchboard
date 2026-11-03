// Держатели процессов claude: Host сам запускает держатель на каждый процесс сессии (файлом keeper из окружения
// SWITCHBOARD_HOLDER) и говорит с ним сам. keeper сессий не знает. Держатель переживает Host: новый Host подключается
// к своим держателям по файлам ~/.switchboard/procs/<callsign>.json, ничьи на старте убивает.
//
// Протокол держателя — заморожен; кадры [тип 1 байт][длина 4 байта, big-endian][данные]:
//   Host → держатель: 'a' ключ (первым), 'i' ввод, 'c' закрыть ввод, 'k' убить дерево процесса
//   держатель → Host: 'h' {pid, buffered}, 'o' вывод, 'x' {code, signal, stderr, os_stop?}, 'e' слово отказа
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import type { SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";

/** Файл держателя. */
export type HoldFile = { id: string; owner: string; pid: number; port: number; key: string; tag?: string };

/** Процесс у держателя: для старта Host. */
export type ProcInfo = { id: string; pid: number };

export type Exited = { op: "exited"; id: string; pid?: number; code: number | null; signal?: string | null; stderr?: string; os_stop?: boolean };

/** Что ядру нужно от ОС: запустить держатель и прочитать файлы держателей. На стенде — подделка. */
export type HolderApi = {
  spawn(s: { id: string; cwd?: string; env?: Record<string, string | undefined>; command: string; args: string[] }): Promise<HoldFile>;
  /** файлы держателей Host */
  files(): HoldFile[];
};

/** Настоящие держатели: файл keeper в режиме hold. */
export function realHolders(home: string, bin: string | undefined): HolderApi {
  return {
    spawn: (s) =>
      new Promise((resolve, reject) => {
        if (!bin) return reject(new Error("нет SWITCHBOARD_HOLDER — файла держателя"));
        const args = ["hold", "--id", s.id, "--owner", "host", ...(s.cwd ? ["--cwd", s.cwd] : []), "--", s.command, ...s.args];
        const env = { ...(s.env ?? process.env), SWITCHBOARD_HOME: home } as NodeJS.ProcessEnv;
        const p = spawn(bin, args, { env, detached: true, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
        let out = "";
        let err = "";
        let done = false;
        p.stdout.setEncoding("utf8");
        p.stderr.setEncoding("utf8");
        p.stderr.on("data", (d: string) => (err += d));
        p.stdout.on("data", (d: string) => {
          out += d;
          const i = out.indexOf("\n");
          if (i < 0 || done) return;
          done = true;
          try {
            const x = JSON.parse(out.slice(0, i)) as { port: number; key: string; pid: number };
            // держатель живёт сам: Host его не ждёт
            p.stdout.destroy();
            p.stderr.destroy();
            p.unref();
            resolve({ id: s.id, owner: "host", pid: x.pid, port: x.port, key: x.key });
          } catch (e) {
            reject(new Error(`строка держателя: ${(e as Error).message}`));
          }
        });
        p.on("error", (e) => !done && ((done = true), reject(e)));
        p.on("exit", (code) => !done && ((done = true), reject(new Error(`держатель вышел с кодом ${code}: ${err.trim()}`))));
      }),
    files: () => {
      const dir = join(home, "procs");
      if (!existsSync(dir)) return [];
      const out: HoldFile[] = [];
      for (const f of readdirSync(dir)) {
        if (!f.endsWith(".json")) continue;
        try {
          const x = JSON.parse(readFileSync(join(dir, f), "utf8")) as HoldFile;
          if (x.owner === "host" && typeof x.id === "string") out.push(x);
        } catch {
          // файл держателя пишется через rename — битый бывает только на миг записи
        }
      }
      return out;
    },
  };
}

/* ===== кадры ===== */

export function frame(t: string, data?: Buffer | string): Buffer {
  const b = typeof data === "string" ? Buffer.from(data) : (data ?? Buffer.alloc(0));
  const h = Buffer.alloc(5);
  h[0] = t.charCodeAt(0);
  h.writeUInt32BE(b.length, 1);
  return Buffer.concat([h, b]);
}

/** Разбор потока на кадры. */
export function frames(on: (t: string, data: Buffer) => void): (b: Buffer) => void {
  let buf: Buffer = Buffer.alloc(0);
  return (b) => {
    buf = buf.length ? Buffer.concat([buf, b]) : b;
    while (buf.length >= 5) {
      const n = buf.readUInt32BE(1);
      if (buf.length < 5 + n) break;
      const t = String.fromCharCode(buf[0]);
      const data = buf.subarray(5, 5 + n);
      buf = buf.subarray(5 + n);
      on(t, data);
    }
  };
}

/* ===== клиент держателей ===== */

export class HolderClient {
  private api: HolderApi;
  private procs = new Map<string, HeldProcess>();
  private onExited: (e: Exited) => void;

  constructor(api: HolderApi, on: { exited: (e: Exited) => void }) {
    this.api = api;
    this.onExited = on.exited;
  }

  /** Процессы сессий, оставшиеся от прежнего Host. */
  list(): ProcInfo[] {
    return this.api.files().map((f) => ({ id: f.id, pid: f.pid }));
  }

  /** Ничей держатель: подключиться и убить. */
  async kill(id: string): Promise<void> {
    const f = this.api.files().find((x) => x.id === id);
    if (!f) return;
    await new Promise<void>((resolve) => {
      const p = new HeldProcess(Promise.resolve(f), this, id);
      p.once("exit", () => resolve());
      p.kill("SIGKILL");
    });
  }

  /** Канал процесса для spawnClaudeCodeProcess: новый держатель или подключение к живому. */
  channel(op: "spawn" | "attach", id: string, o: SpawnOptions): HeldProcess {
    const file =
      op === "spawn"
        ? this.api.spawn({ id, cwd: o.cwd, env: o.env, command: o.command, args: o.args })
        : (async () => {
            const f = this.api.files().find((x) => x.id === id);
            if (!f) throw new Error("unknown_id");
            return f;
          })();
    const p = new HeldProcess(file, this, id);
    this.procs.set(id, p);
    return p;
  }

  exited(p: HeldProcess, e: Exited): void {
    if (this.procs.get(e.id) === p) this.procs.delete(e.id);
    this.onExited(e);
  }

  /** Выход Host: соединения закрыты без «закрой ввод» и «убей» — держатели держат процессы и копят вывод. */
  close(): void {
    for (const p of this.procs.values()) p.detach();
    this.procs.clear();
  }
}

/** Процесс claude у держателя глазами SDK. stdin.end() → «закрой ввод»; kill(signal) → «убей». */
export class HeldProcess extends EventEmitter implements SpawnedProcess {
  stdin: Writable;
  stdout = new PassThrough();
  killed = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  pid: number | null = null;
  readonly id: string;
  private sock: net.Socket | null = null;
  private pending: Buffer[] = [];
  private detached = false;
  private finished = false;
  private client: HolderClient;

  constructor(file: Promise<HoldFile>, client: HolderClient, id: string) {
    super();
    this.id = id;
    this.client = client;
    this.stdin = new Writable({
      write: (chunk: Buffer, _enc, cb) => {
        this.out(frame("i", chunk));
        cb();
      },
      final: (cb) => {
        // SDK закрывает ввод в close(): держатель закрывает ввод claude, процесс выходит сам
        this.out(frame("c"));
        cb();
      },
    });
    this.stdin.on("error", () => {});
    file.then(
      (f) => this.connect(f),
      (e: Error) => this.finish({ op: "exited", id, code: null, signal: null, stderr: `держатель: ${e.message}` }),
    );
  }

  private connect(f: HoldFile): void {
    if (this.detached) return;
    const sock = net.connect(f.port, "127.0.0.1");
    this.sock = sock;
    sock.on("error", () => {});
    sock.on("connect", () => {
      sock.write(frame("a", f.key));
      for (const b of this.pending.splice(0)) sock.write(b);
    });
    sock.on(
      "data",
      frames((t, data) => {
        if (t === "h") this.pid = (JSON.parse(data.toString("utf8")) as { pid: number }).pid;
        else if (t === "o") {
          if (!this.stdout.writableEnded) this.stdout.write(data);
        } else if (t === "x") {
          const x = JSON.parse(data.toString("utf8")) as { code: number | null; signal: string | null; stderr: string; os_stop?: boolean };
          this.finish({ op: "exited", id: this.id, pid: this.pid ?? undefined, code: x.code, signal: x.signal, stderr: x.stderr, os_stop: x.os_stop });
          sock.end();
        } else if (t === "e") {
          this.finish({ op: "exited", id: this.id, code: null, signal: null, stderr: `держатель: ${data.toString("utf8")}` });
          sock.destroy();
        }
      }),
    );
    // держатель пропал, не отдав выход: его процесс умер вместе с ним
    sock.on("close", () => this.finish({ op: "exited", id: this.id, pid: this.pid ?? undefined, code: null, signal: null, stderr: "держатель пропал" }));
  }

  private out(b: Buffer): void {
    if (this.finished || this.detached) return;
    if (this.sock && !this.sock.connecting && !this.sock.destroyed) this.sock.write(b);
    else this.pending.push(b);
  }

  /** SDK зовёт kill после ожидания конца ввода: процесс и потомки — сразу. */
  kill(_signal: NodeJS.Signals): boolean {
    this.killed = true;
    this.out(frame("k"));
    return true;
  }

  private finish(e: Exited): void {
    if (this.finished || this.detached) return;
    this.finished = true;
    this.exitCode = e.code;
    this.signalCode = (e.signal ?? null) as NodeJS.Signals | null;
    if (!this.stdout.writableEnded) this.stdout.end();
    this.client.exited(this, e);
    this.emit("exit", e.code, this.signalCode);
  }

  /** Выход Host: соединение закрыто без «закрой ввод» и «убей». */
  detach(): void {
    this.detached = true;
    this.sock?.destroy();
  }
}
