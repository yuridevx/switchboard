// Хранилище Host: ~/.switchboard/store/<раздел>.json. У раздела один владелец — модуль с тем же именем;
// core.json — список сессий ядра. Запись сразу: временный файл и rename — файл всегда целый JSON.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionState, Store } from "../contract.ts";

/** Файл раздела модуля: своё машины и своё каждой сессии. */
type Section = { machine?: unknown; sessions?: Record<string, unknown> };

/** Запись сессии в core.json. */
export type CoreRecord = {
  callsign: string;
  session_id: string;
  cwd: string;
  /** версия SDK, которой запущен процесс */
  sdk: string;
  stopped: boolean;
  /** копия: id исходного разговора — до первого хода копии её файла нет */
  fork?: string;
  /** последнее состояние: после attach посреди хода ядро показывает его до следующего сигнала SDK */
  state?: SessionState;
  /** отправитель последнего ввода: кому вопрос сессии и после перезапуска Host */
  from?: string;
};

const clone = <T>(v: T): T => (v === undefined ? v : structuredClone(v));

export class Stores {
  readonly dir: string;
  private cache = new Map<string, Section>();

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
  }

  private read(name: string): Section {
    let s = this.cache.get(name);
    if (!s) {
      const f = join(this.dir, name + ".json");
      s = existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as Section) : {};
      this.cache.set(name, s);
    }
    return s;
  }

  private write(name: string, s: Section): void {
    const f = join(this.dir, name + ".json");
    const tmp = f + ".tmp";
    writeFileSync(tmp, JSON.stringify(s, null, 1));
    renameSync(tmp, f);
  }

  /** Раздел модуля для машины. */
  machine<T>(name: string): Store<T> {
    const get = () => clone(this.read(name).machine as T | undefined);
    const set = (v: T | undefined) => {
      const s = this.read(name);
      if (v === undefined) delete s.machine;
      else s.machine = clone(v);
      this.write(name, s);
    };
    return { get, set, update: (fn) => { const v = fn(get()); set(v); return clone(v); } };
  }

  /** Раздел модуля для сессии. */
  session<T>(name: string, callsign: string): Store<T> {
    const get = () => clone(this.read(name).sessions?.[callsign] as T | undefined);
    const set = (v: T | undefined) => {
      const s = this.read(name);
      s.sessions ??= {};
      if (v === undefined) delete s.sessions[callsign];
      else s.sessions[callsign] = clone(v);
      this.write(name, s);
    };
    return { get, set, update: (fn) => { const v = fn(get()); set(v); return clone(v); } };
  }

  /** s.remove(): стереть разделы этой сессии у всех модулей. */
  removeSession(callsign: string): void {
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith(".json") || f === "core.json") continue;
      const name = f.slice(0, -5);
      const s = this.read(name);
      if (s.sessions && callsign in s.sessions) {
        delete s.sessions[callsign];
        this.write(name, s);
      }
    }
  }

  /** Список сессий ядра. */
  core(): CoreRecord[] {
    return clone(((this.read("core") as { sessions?: CoreRecord[] }).sessions ?? []) as CoreRecord[]);
  }

  saveCore(list: CoreRecord[]): void {
    const s = { sessions: clone(list) } as unknown as Section;
    this.cache.set("core", s);
    this.write("core", s);
  }
}
