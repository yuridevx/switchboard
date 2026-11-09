// Хранилище Host: store/<модуль>.json — { machine, sessions: { callsign: … } }, store/core.json — { sessions: [запись] }. Запись сразу: временный файл и rename.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionState, Spec } from "@sb/protocol";
import type { Store } from "./contract.ts";

/** Запись сессии у ядра: с неё начинает новый Host. fork — разговор, от которого пошла копия, пока своего файла нет. */
export type CoreRecord = {
  callsign: string;
  spec: Spec;
  /** папка на диске: spec.cwd глазами машины */
  cwd: string;
  sessionId: string;
  sdk: string;
  stopped: boolean;
  state?: SessionState;
  by: string;
  since: number;
  last?: number;
  fork?: string;
  error?: string;
};

type Sections = { machine?: unknown; sessions?: Record<string, unknown> };

/** Значение таким, каким его прочтёт следующий Host. */
const copy = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));

export class Disk {
  private files = new Map<string, Sections>();
  private dir: string;

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
  }

  private path = (name: string) => join(this.dir, `${name}.json`);

  private file(name: string): Sections {
    let f = this.files.get(name);
    if (!f) {
      f = existsSync(this.path(name)) ? (JSON.parse(readFileSync(this.path(name), "utf8")) as Sections) : {};
      this.files.set(name, f);
    }
    return f;
  }

  private write(name: string, value: unknown): void {
    const tmp = `${this.path(name)}.tmp`;
    writeFileSync(tmp, JSON.stringify(value), { flush: true });
    renameSync(tmp, this.path(name));
  }

  /** Раздел модуля: машины или сессии callsign. */
  section<T>(name: string, callsign?: string): Store<T> {
    const get = () => {
      const f = this.file(name);
      return (callsign === undefined ? f.machine : f.sessions?.[callsign]) as T | undefined;
    };
    const set = (value: T | undefined) => {
      const f = this.file(name);
      if (callsign === undefined) f.machine = value;
      else if (value === undefined) delete (f.sessions ??= {})[callsign];
      else (f.sessions ??= {})[callsign] = value;
      this.write(name, f);
    };
    return {
      get: () => copy(get()),
      set: (v) => set(copy(v)),
      update(fn) {
        const v = fn(copy(get()));
        set(copy(v));
        return copy(v);
      },
    };
  }

  /** Разделы сессии у всех модулей на диске. */
  dropSession(callsign: string): void {
    for (const f of readdirSync(this.dir)) {
      const name = f.slice(0, -".json".length);
      if (!f.endsWith(".json") || name === "core" || this.file(name).sessions?.[callsign] === undefined) continue;
      delete this.file(name).sessions![callsign];
      this.write(name, this.file(name));
    }
  }

  records(): CoreRecord[] {
    return existsSync(this.path("core")) ? (JSON.parse(readFileSync(this.path("core"), "utf8")) as { sessions: CoreRecord[] }).sessions : [];
  }

  saveRecords(sessions: CoreRecord[]): void {
    this.write("core", { sessions });
  }
}
