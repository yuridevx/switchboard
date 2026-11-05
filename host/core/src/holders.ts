// Держатели процессов claude: файл keeper в режиме hold держит процесс и переживает Host.
// Протокол заморожен: TCP на 127.0.0.1, кадры [тип 1 байт][длина 4 байта, big-endian][данные].
//   хозяин → держатель: a ключ (первым), i ввод, c закрыть ввод, k убить дерево процесса
//   держатель → хозяин: h {pid, buffered}, o вывод, x {code, signal, stderr, os_stop?}, e слово отказа
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import type { SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";

export type HoldFile = { id: string; owner: string; pid: number; port: number; key: string; tag?: string };

/** То, что ядро берёт от ОС: запустить держатель и список живых. */
export interface HolderApi {
  spawn(s: { id: string; cwd?: string; env?: Record<string, string | undefined>; command: string; args: string[] }): Promise<HoldFile>;
  files(): HoldFile[];
}

/** Выход процесса, как его отдаёт держатель. */
export type Exit = { code: number | null; signal: string | null; stderr: string; os_stop?: boolean };

/** Кусок ввода в одном кадре: держатель не примет кадр больше 4 МиБ. */
const CHUNK = 1 << 20;
const HOLDER_WAIT_MS = 30_000;

export function frame(type: string, data: string | Buffer = ""): Buffer {
  const body = typeof data === "string" ? Buffer.from(data) : data;
  const head = Buffer.alloc(5);
  head.write(type, 0, "latin1");
  head.writeUInt32BE(body.length, 1);
  return Buffer.concat([head, body]);
}

/** Разбор потока на кадры: кадр может прийти кусками. */
export function frames(on: (type: string, data: Buffer) => void): (chunk: Buffer) => void {
  let rest: Buffer = Buffer.alloc(0);
  return (chunk) => {
    rest = rest.length ? Buffer.concat([rest, chunk]) : chunk;
    while (rest.length >= 5) {
      const end = 5 + rest.readUInt32BE(1);
      if (rest.length < end) return;
      const type = String.fromCharCode(rest[0]);
      const data = rest.subarray(5, end);
      rest = rest.subarray(end);
      on(type, data);
    }
  };
}

const lost = (stderr: string): Exit => ({ code: null, signal: null, stderr });

/** Процесс у держателя глазами SDK. Убивает его только ядро (terminate) по своему пределу: kill от SDK ничего не делает. */
export class Held extends EventEmitter implements SpawnedProcess {
  readonly id: string;
  readonly stdin = new PassThrough();
  readonly stdout = new Readable({ read() {} });
  readonly exit: Promise<Exit>;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  /** true после выхода и после drop: SDK на выходе из Host не трогает такой процесс */
  killed = false;
  private sock: net.Socket | null = null;
  private done = false;
  private exited!: (e: Exit) => void;

  constructor(id: string, file: HoldFile | Promise<HoldFile>) {
    super();
    this.id = id;
    this.exit = new Promise((resolve) => (this.exited = resolve));
    if (file instanceof Promise) file.then((f) => this.connect(f), (e: Error) => this.finish(lost(`держатель: ${e.message}`)));
    else this.connect(file);
  }

  private connect(file: HoldFile): void {
    if (this.done) return;
    const sock = (this.sock = net.connect(file.port, "127.0.0.1"));
    sock.write(frame("a", file.key));
    sock.on("error", () => {});
    sock.on("close", () => this.finish(lost("держатель пропал")));
    sock.on(
      "data",
      frames((type, data) => {
        if (type === "o") this.stdout.push(data);
        else if (type === "x") this.finish(JSON.parse(data.toString("utf8")) as Exit);
        else if (type === "e") this.finish(lost(`держатель: ${data.toString("utf8")}`));
      }),
    );
    this.stdin.on("data", (d: Buffer) => {
      for (let at = 0; at < d.length; at += CHUNK) this.send("i", d.subarray(at, at + CHUNK));
    });
    this.stdin.on("end", () => this.send("c"));
  }

  private send(type: string, data?: Buffer): void {
    if (!this.done) this.sock?.write(frame(type, data));
  }

  /** Выход идёт после вывода: следующий тик отдаёт читателю всё, что он ещё не забрал. */
  private finish(e: Exit): void {
    if (this.done) return;
    this.done = true;
    this.killed = true;
    this.exitCode = e.code;
    this.signalCode = e.signal as NodeJS.Signals | null;
    this.sock?.destroy();
    this.stdout.push(null);
    setImmediate(() => {
      this.emit("exit", e.code, e.signal);
      this.exited(e);
    });
  }

  kill(): boolean {
    return false;
  }

  /** Убить дерево процесса: кадр k. */
  terminate(): void {
    this.send("k");
  }

  /** Отпустить соединение: процесс живёт у держателя, Host уходит. */
  drop(): void {
    this.done = true;
    this.killed = true;
    this.sock?.destroy();
  }
}

/** Соединения этого Host с держателями: штатный выход отпускает их все разом. */
export class Holders {
  private readonly api: HolderApi;
  private readonly live = new Set<Held>();

  constructor(api: HolderApi) {
    this.api = api;
  }

  files(): HoldFile[] {
    return this.api.files();
  }

  private track(held: Held): Held {
    this.live.add(held);
    void held.exit.then(() => this.live.delete(held));
    return held;
  }

  /** Новый держатель с процессом, как его собрал SDK. */
  spawn(id: string, o: SpawnOptions): Held {
    return this.track(new Held(id, this.api.spawn({ id, cwd: o.cwd, env: o.env, command: o.command, args: o.args })));
  }

  /** Подключиться к живому: новый хозяин вытесняет прежнего. */
  attach(id: string): Held {
    const file = this.files().find((f) => f.id === id);
    return this.track(new Held(id, file ?? Promise.reject(new Error("unknown_id"))));
  }

  open(file: HoldFile): Held {
    return this.track(new Held(file.id, file));
  }

  close(): void {
    for (const held of this.live) held.drop();
    this.live.clear();
  }
}

/** Настоящие держатели: file — файл keeper, procs/ — их файлы о себе. */
export function realHolders(home: string, file?: string): HolderApi {
  const procs = join(home, "procs");
  return {
    files() {
      if (!existsSync(procs)) return [];
      return readdirSync(procs)
        .filter((name) => name.endsWith(".json"))
        .flatMap((name) => {
          try {
            const f = JSON.parse(readFileSync(join(procs, name), "utf8")) as HoldFile;
            return f.owner === "host" ? [f] : [];
          } catch {
            return []; // держатель дописывает свой файл или файл битый: процесса для Host нет
          }
        });
    },
    spawn(s) {
      if (!file) return Promise.reject(new Error("нет SWITCHBOARD_HOLDER — файла держателя"));
      const args = ["hold", "--id", s.id, "--owner", "host", ...(s.cwd ? ["--cwd", s.cwd] : []), "--", s.command, ...s.args];
      return new Promise((resolve, reject) => {
        const child = spawn(file, args, { env: { ...s.env, SWITCHBOARD_HOME: home }, detached: true, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
        const limit = setTimeout(() => {
          child.kill();
          reject(new Error(`держатель не ответил за ${HOLDER_WAIT_MS / 1000} с`));
        }, HOLDER_WAIT_MS);
        let line = "";
        child.on("error", (e) => {
          clearTimeout(limit);
          reject(e);
        });
        child.on("exit", (code) => {
          clearTimeout(limit);
          reject(new Error(`держатель вышел с кодом ${code}`));
        });
        child.stdout.on("data", (d: Buffer) => {
          line += d.toString("utf8");
          if (!line.includes("\n")) return;
          clearTimeout(limit);
          // держатель живёт сам: строка о себе — последнее, что Host от него читает
          child.stdout.destroy();
          child.removeAllListeners("exit");
          child.unref();
          try {
            const about = JSON.parse(line) as { port: number; key: string; pid: number };
            resolve({ id: s.id, owner: "host", pid: about.pid, port: about.port, key: about.key });
          } catch (e) {
            reject(e as Error);
          }
        });
      });
    },
  };
}
