// Держатели процессов claude. Протокол заморожен, им же говорит keeper: TCP на 127.0.0.1, кадры [тип 1 байт][длина 4 байта, big-endian][данные].
//   хозяин → держатель: a ключ (первым), i ввод, c закрыть ввод, k убить дерево процесса
//   держатель → хозяин: h {pid, buffered}, o вывод, x {code, signal, stderr, os_stop?}, e слово отказа
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";

/** Файл держателя procs/<id>.json. */
export type HoldFile = { id: string; owner: string; pid: number; port: number; key: string };
export type HoldSpec = { id: string; command: string; args: string[]; cwd?: string; env?: Record<string, string | undefined> };
export type HolderApi = { spawn(s: HoldSpec): Promise<HoldFile>; files(): HoldFile[] };
/** Выход процесса: кадр держателя или слова о том, что держателя нет. */
export type Exit = { code: number | null; signal: string | null; stderr: string; os_stop?: boolean };

/** Держатель читает кадр до 4 МиБ: длинный ввод идёт кусками. */
const INPUT_CHUNK = 1 << 20;
const SPAWN_MS = 30_000;

export function frame(type: string, data: string | Buffer = ""): Buffer {
  const body = Buffer.from(data);
  const head = Buffer.alloc(5);
  head.write(type, "latin1");
  head.writeUInt32BE(body.length, 1);
  return Buffer.concat([head, body]);
}

/** Режет поток байт на кадры. */
export function frames(on: (type: string, data: Buffer) => void): (chunk: Buffer) => void {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 5 && buf.length >= 5 + buf.readUInt32BE(1)) {
      const end = 5 + buf.readUInt32BE(1);
      on(String.fromCharCode(buf[0]), buf.subarray(5, end));
      buf = buf.subarray(end);
    }
  };
}

/** Процесс у держателя глазами SDK. kill SDK не слышит: когда убивать, решает ядро; соединение снято — процесс живёт дальше. */
export class Hold extends EventEmitter {
  /** callsign сессии */
  readonly id: string;
  readonly stdout = new PassThrough();
  readonly stdin = new Writable({
    write: (chunk: Buffer, _enc, done) => {
      for (let at = 0; at < chunk.length; at += INPUT_CHUNK) this.out(frame("i", chunk.subarray(at, at + INPUT_CHUNK)));
      done();
    },
    final: (done) => {
      this.out(frame("c"));
      done();
    },
  });
  readonly killed = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly exited: Promise<Exit>;
  private finish!: (x: Exit) => void;
  private sock: net.Socket | null = null;
  private waiting: Buffer[] = [];
  private over = false;

  constructor(id: string, file: Promise<HoldFile>) {
    super();
    this.id = id;
    this.exited = new Promise((resolve) => {
      this.finish = (x) => {
        if (this.over) return;
        this.over = true;
        this.exitCode = x.code ?? 1;
        this.signalCode = x.signal as NodeJS.Signals | null;
        this.stdout.end();
        this.sock?.destroy();
        // выход идёт после вывода: следующий тик отдаёт читателю всё, что он ещё не забрал. Код не null: иначе SDK ждёт выхода, который уже был
        setImmediate(() => {
          this.emit("exit", this.exitCode, x.signal);
          resolve(x);
        });
      };
    });
    file.then(
      (f) => this.connect(f),
      (e: Error) => this.finish({ code: null, signal: null, stderr: `держатель: ${e.message}` }),
    );
  }

  private connect(f: HoldFile): void {
    if (this.over) return;
    const sock = net.connect(f.port, "127.0.0.1");
    this.sock = sock;
    sock.on("error", () => {});
    sock.on("close", () => this.finish({ code: null, signal: null, stderr: "держатель пропал" }));
    sock.on(
      "data",
      frames((type, data) => {
        if (type === "o") this.stdout.write(Buffer.from(data));
        else if (type === "x") this.finish(JSON.parse(data.toString("utf8")) as Exit);
        else if (type === "e") this.finish({ code: null, signal: null, stderr: `держатель: ${data.toString("utf8")}` });
      }),
    );
    sock.write(frame("a", f.key));
    for (const b of this.waiting.splice(0)) sock.write(b);
  }

  private out(b: Buffer): void {
    if (this.over) return;
    if (this.sock) this.sock.write(b);
    else this.waiting.push(b);
  }

  /** «Убей» от ядра. */
  destroy(): void {
    this.out(frame("k"));
  }

  /** Для SDK: убивает только ядро. */
  kill(): boolean {
    return false;
  }

  /** Host уходит: соединение снято, выхода не будет, процесс живёт у держателя. */
  detach(): void {
    this.over = true;
    this.sock?.destroy();
  }
}

/** Соединения ядра с держателями: новые процессы и уже живые. */
export class Holders {
  private held = new Set<Hold>();
  private api: HolderApi;

  constructor(api: HolderApi) {
    this.api = api;
  }

  files = (): HoldFile[] => this.api.files();

  private keep(id: string, file: Promise<HoldFile>): Hold {
    const h = new Hold(id, file);
    this.held.add(h);
    void h.exited.then(() => this.held.delete(h));
    return h;
  }

  spawn = (s: HoldSpec): Hold => this.keep(s.id, this.api.spawn(s));

  /** Процесс, оставшийся от прежнего Host: файла уже нет — отказ словом держателя. */
  attach(id: string): Hold {
    const file = this.files().find((f) => f.id === id);
    return this.keep(id, file ? Promise.resolve(file) : Promise.reject(new Error("unknown_id")));
  }

  connect = (file: HoldFile): Hold => this.keep(file.id, Promise.resolve(file));

  close(): void {
    for (const h of this.held) h.detach();
  }
}

/** Настоящие держатели: файл keeper с командой hold, файлы — procs/ папки данных. */
export function realHolders(home: string, bin: string | undefined): HolderApi {
  return {
    files() {
      const dir = join(home, "procs");
      if (!existsSync(dir)) return [];
      return readdirSync(dir).flatMap((name) => {
        try {
          const f = name.endsWith(".json") ? (JSON.parse(readFileSync(join(dir, name), "utf8")) as HoldFile) : null;
          return f?.owner === "host" ? [f] : [];
        } catch {
          return []; // файл дописывают или он битый: о нём скажет держатель
        }
      });
    },
    spawn(s) {
      if (!bin) return Promise.reject(new Error("нет SWITCHBOARD_HOLDER — файла держателя"));
      return new Promise((resolve, reject) => {
        const args = ["hold", "--id", s.id, "--owner", "host", "--cwd", s.cwd ?? home, "--", s.command, ...s.args];
        const child = spawn(bin, args, { env: s.env, stdio: ["ignore", "pipe", "pipe"], detached: true, windowsHide: true });
        let out = "";
        let err = "";
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error(`держатель не ответил за ${SPAWN_MS / 1000} с`));
        }, SPAWN_MS);
        child.on("error", (e) => {
          clearTimeout(timer);
          reject(e);
        });
        child.on("exit", (code) => {
          clearTimeout(timer);
          reject(new Error(`держатель вышел с кодом ${code}: ${err.trim()}`));
        });
        child.stderr.on("data", (d) => (err += d));
        child.stdout.on("data", (d) => {
          out += d;
          if (!out.includes("\n")) return;
          clearTimeout(timer);
          child.removeAllListeners("exit");
          child.stdout.destroy();
          child.stderr.destroy();
          child.unref();
          try {
            const { port, key, pid } = JSON.parse(out) as HoldFile;
            resolve({ id: s.id, owner: "host", pid, port, key });
          } catch (e) {
            reject(new Error(`строка держателя: ${(e as Error).message}`));
          }
        });
      });
    },
  };
}
