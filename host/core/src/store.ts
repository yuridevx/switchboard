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

const CORE = "core";
const copy = <T>(v: T): T => (v === undefined ? v : structuredClone(v));

export class Stores {
  private readonly dir: string;
  private readonly sections = new Map<string, Section>();

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
  }

  private section(name: string): Section {
    let s = this.sections.get(name);
    if (!s) {
      const f = join(this.dir, name + ".json");
      s = existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as Section) : {};
      this.sections.set(name, s);
    }
    return s;
  }

  private write(name: string, s: Section): void {
    const f = join(this.dir, name + ".json");
    // сброс на диск до rename: после обрыва питания файл старый или новый, а не нули
    writeFileSync(f + ".tmp", JSON.stringify(s, null, 1), { flush: true });
    renameSync(f + ".tmp", f);
  }

  /** Store над одним значением раздела: чтение — копия, запись — сразу. */
  private store<T>(read: () => unknown, change: (v: T | undefined) => void): Store<T> {
    const get = () => copy(read() as T | undefined);
    return { get, set: change, update: (fn) => { const v = fn(get()); change(v); return copy(v); } };
  }

  /** Раздел модуля для машины. */
  machine<T>(name: string): Store<T> {
    return this.store<T>(() => this.section(name).machine, (v) => {
      const s = this.section(name);
      if (v === undefined) delete s.machine;
      else s.machine = copy(v);
      this.write(name, s);
    });
  }

  /** Раздел модуля для сессии. */
  session<T>(name: string, callsign: string): Store<T> {
    return this.store<T>(() => this.section(name).sessions?.[callsign], (v) => {
      const s = this.section(name);
      s.sessions ??= {};
      if (v === undefined) delete s.sessions[callsign];
      else s.sessions[callsign] = copy(v);
      this.write(name, s);
    });
  }

  /** s.remove(): стереть разделы этой сессии у всех модулей. */
  removeSession(callsign: string): void {
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith(".json") || f === CORE + ".json") continue;
      const name = f.slice(0, -".json".length);
      const s = this.section(name);
      if (s.sessions && callsign in s.sessions) {
        delete s.sessions[callsign];
        this.write(name, s);
      }
    }
  }

  /** Список сессий ядра. */
  core(): CoreRecord[] {
    return copy(((this.section(CORE) as { sessions?: CoreRecord[] }).sessions ?? []) as CoreRecord[]);
  }

  saveCore(list: CoreRecord[]): void {
    const s = { sessions: copy(list) } as unknown as Section;
    this.sections.set(CORE, s);
    this.write(CORE, s);
  }
}
