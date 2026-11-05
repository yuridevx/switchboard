// Хранилище на диске: store/<модуль>.json — { machine, sessions: { callsign: … } }, store/core.json — { sessions: [запись] }.
// Запись сразу: временный файл и rename, файл всегда целый JSON. Прочитанное держится в памяти процесса.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionState, Store } from "../contract.ts";

/** Запись сессии в core.json: её читает следующий Host. */
export type CoreRecord = {
  callsign: string;
  cwd: string;
  session_id: string;
  sdk: string;
  /** остановлена намеренно: новый Host её не поднимает */
  stopped: boolean;
  state?: SessionState;
  /** отправитель последнего ввода */
  from?: string;
  /** копия: разговор, от которого она пошла */
  fork?: string;
};

type Doc = { machine?: unknown; sessions?: Record<string, unknown> };

const clone = <T>(value: T): T => (value === undefined ? value : JSON.parse(JSON.stringify(value)));

export class Stores {
  private readonly dir: string;
  private readonly docs = new Map<string, Doc>();

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.dir = dir;
  }

  private read<T>(name: string): T | undefined {
    const file = join(this.dir, `${name}.json`);
    return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as T) : undefined;
  }

  private write(name: string, value: unknown): void {
    const file = join(this.dir, `${name}.json`);
    // сброс на диск до rename: после обрыва питания файл старый или новый, а не нули
    writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 1), { flush: true });
    renameSync(`${file}.tmp`, file);
  }

  private doc(name: string): Doc {
    let doc = this.docs.get(name);
    if (!doc) this.docs.set(name, (doc = this.read<Doc>(name) ?? {}));
    return doc;
  }

  /** Раздел модуля: машины или, с callsign, этой сессии. */
  section<T>(name: string, callsign?: string): Store<T> {
    const get = () => clone((callsign ? this.doc(name).sessions?.[callsign] : this.doc(name).machine) as T | undefined);
    const set = (value: T | undefined) => {
      const doc = this.doc(name);
      const place = (callsign ? (doc.sessions ??= {}) : doc) as Record<string, unknown>;
      const key = callsign ?? "machine";
      if (value === undefined) delete place[key];
      else place[key] = clone(value);
      this.write(name, doc);
    };
    return {
      get,
      set,
      update(fn) {
        set(fn(get()));
        return get();
      },
    };
  }

  /** Стереть разделы сессии у всех модулей на диске. */
  forget(callsign: string): void {
    for (const file of readdirSync(this.dir)) {
      if (!file.endsWith(".json") || file === "core.json") continue;
      const name = file.slice(0, -".json".length);
      const doc = this.doc(name);
      if (doc.sessions?.[callsign] === undefined) continue;
      delete doc.sessions[callsign];
      this.write(name, doc);
    }
  }

  records(): CoreRecord[] {
    return this.read<{ sessions: CoreRecord[] }>("core")?.sessions ?? [];
  }

  saveRecords(sessions: CoreRecord[]): void {
    this.write("core", { sessions });
  }
}
