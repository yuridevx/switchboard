// Стенд Host: настоящее ядро на поддельных SDK, relay, держателях и часах. Хранилище и журнал — во временной папке.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nameOf, READ_MS, type Frame } from "@switchboard/protocol";
import type { Host, Manifest, Module, Session } from "../contract.ts";
import { Kernel, Mod, StartError } from "../src/kernel.ts";
import type { HostConfig } from "../src/kernel.ts";
import type { ModuleEntry } from "../src/release.ts";
import type { CoreRecord } from "../src/store.ts";
import { FakeClock } from "./clock.ts";
import { FakeHolders } from "./holders.ts";
import type { FakeProc } from "./holders.ts";
import { FakeRelay } from "./relay.ts";
import { FakeSdk } from "./sdk.ts";
import type { FakeQuery } from "./sdk.ts";

export const CORE: Manifest = {
  name: "host",
  type: "sdk-core",
  version: "1.0.0",
  provides: { "host.module": 1 },
  uses: { "manifest.check@manifest-gate": 1, "hello@relay": 1, "session.state@relay": 1 },
  config: {},
};

/**
 * Модуль для стенда: манифест собирается из объекта — provides из requests, frames, fields, decide и elicit (версия 1)
 * плюс extra.provides; uses, calls, version — из extra.
 */
export function module(name: string, mod: Module, extra: Partial<Manifest> = {}): ModuleEntry {
  const provides: Record<string, number> = {};
  const decide = Object.keys(mod.decide ?? {}).map((x) => `decide.${x}`);
  for (const n of [...Object.keys(mod.requests ?? {}), ...Object.keys(mod.frames ?? {}), ...Object.keys(mod.fields ?? {}), ...decide, ...(mod.elicit ? ["elicit"] : [])]) provides[n] = 1;
  return {
    manifest: {
      name,
      type: "sdk",
      version: extra.version ?? "1.0.0",
      provides: { ...provides, ...(extra.provides ?? {}) },
      uses: extra.uses ?? {},
      calls: extra.calls ?? [],
      config: extra.config ?? {},
    },
    module: mod,
  };
}

/** Выпуск для host.reload на стенде. */
export type StandOptions = {
  modules?: ModuleEntry[];
  machine?: string;
  /** relay в host.json; по умолчанию есть */
  relay?: boolean;
  /** Worker'ы сверх стандартных в списке сборки: модуль включает своё по наличию адреса */
  workers?: Record<string, string>;
  /** core.json до старта: сессии прежнего Host */
  sessions?: Array<Partial<CoreRecord> & { callsign: string }>;
  /** папка ~/.switchboard — та же между перезапусками Host */
  home?: string;
  /** держатели — те же между перезапусками Host */
  holders?: FakeHolders;
  relayStand?: FakeRelay;
  sdkVersion?: string;
  version?: string;
  config?: Partial<HostConfig>;
  /** стартовать сразу; по умолчанию да */
  start?: boolean;
  /** первая пауза переподключения клиента рации; по умолчанию 1 с */
  pauseMs?: number;
};

export type Stand = {
  kernel: Kernel;
  sdk: FakeSdk;
  holders: FakeHolders;
  relay: FakeRelay;
  clock: FakeClock;
  home: string;
  /** коды выхода процесса Host */
  exits: number[];
  /** ошибка старта, если Host не стартовал */
  startError: StartError | null;
  start(): Promise<void>;
  /** host модуля, как его видит модуль */
  host(module: string): Host;
  /** сессия глазами модуля */
  session(module: string, callsign: string): Session | undefined;
  /** host.open от имени модуля */
  open(callsign: string, o?: { module?: string; cwd?: string; opening?: Record<string, unknown>; mkdir?: boolean }): Promise<Session>;
  /** процесс сессии у держателя */
  proc(callsign: string): FakeProc;
  /** нынешний query() сессии */
  query(callsign: string): FakeQuery;
  /** строки журнала Host */
  journal(): Array<Record<string, any>>;
  /** кадры session.state сессии */
  states(callsign: string): Array<Record<string, any>>;
  /** штатная остановка Host и поддельных держателей */
  close(): Promise<void>;
  /** Host убит: соединения с держателями и relay закрыты без штатной остановки, процессы живут у держателей */
  crash(): void;
};

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

/** Настоящий предел open и start стенда. Пределы ядра идут по поддельным часам и без clock.tick не наступают: модуль, который ждёт то,
 *  чего стенд не даёт, падает словом, а не висит до testTimeout. Вдвое выше предела чтения: модуль вправе ждать по настоящим часам READ_MS
 *  (fleet ждёт пропуск у gate); ниже testTimeout 30 с. Замер 10 нояб.: open не дольше 423 мс, start — 118 мс. */
const STAND_MS = 2 * READ_MS;
function real<T>(p: Promise<T>, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const why = `стенд: ${what} не кончился за ${STAND_MS / 1000} с по настоящим часам — ждёт то, чего стенд не даёт; пределы ядра идут по поддельным часам (clock.tick)`;
    const t = realSetTimeout(() => reject(new Error(why)), STAND_MS);
    p.then(resolve, reject).finally(() => realClearTimeout(t));
  });
}

/** Процесс мёртв: его нет. На Linux kill(pid, 0) успешен и у зомби, которого не подобрал родитель, и у получившего SIGKILL в первые миллисекунды:
 *  зомби — мёртв, остальное ждут until. */
export function isDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return process.platform !== "win32" && readFileSync(`/proc/${pid}/stat`, "utf8").replace(/^.*\) /, "")[0] === "Z";
  } catch {
    return true;
  }
}

/** Дождаться условия: опрос по настоящим часам (поддельные таймеры vitest его не останавливают). */
export async function until<T>(fn: () => T | undefined | null | false, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`не дождались: ${fn.toString().slice(0, 160)}`);
    await new Promise((r) => realSetTimeout(r, 5));
  }
}

/** Собрать стенд и запустить Host. */
export async function standHost(o: StandOptions = {}): Promise<Stand> {
  const machine = o.machine ?? "laptop";
  // папка данных — как у main: своя, иначе SWITCHBOARD_HOME, иначе временная
  const home = o.home ?? process.env.SWITCHBOARD_HOME ?? mkdtempSync(join(tmpdir(), "switchboard-stand-"));
  mkdirSync(join(home, "store"), { recursive: true });
  if (o.sessions) {
    const list: CoreRecord[] = o.sessions.map((s) => ({
      session_id: `sid-${nameOf(s.callsign)}`,
      cwd: join(home, "work", nameOf(s.callsign)),
      sdk: o.sdkVersion ?? "0.3.311",
      stopped: false,
      ...s,
    }));
    writeFileSync(join(home, "store", "core.json"), JSON.stringify({ sessions: list }));
  }
  const holders = o.holders ?? new FakeHolders();
  const relay = o.relayStand ?? new FakeRelay();
  const sdk = new FakeSdk(o.sdkVersion ?? "0.3.311");
  const clock = new FakeClock();
  const exits: number[] = [];
  let crashed = false;
  const config: HostConfig = { machine, ...(o.config ?? {}) };
  const kernel = new Kernel({
    home,
    config,
    core: CORE,
    // адреса флота — в списке сборки: relay: false — сборка без relay
    release: { version: o.version ?? "1.4.1", sdk: sdk.version, modules: o.modules ?? [], workers: o.relay === false ? {} : { ...FakeRelay.WORKERS, ...o.workers } },
    sdk,
    holders,
    relayKey: `host.${machine}.k7f3.stand`,
    WebSocket: relay.WebSocket,
    fetch: relay.fetch,
    clock,
    exit: (code) => exits.push(code),
    pauseMs: o.pauseMs ?? 1000,
  });
  // свой модуль стенда вне списка: тест видит сессию так же, как модуль
  const standMod = new Mod({ name: "stand", type: "sdk", version: "0.0.0", provides: {}, uses: {}, config: {} }, {});
  const st: Stand = {
    kernel,
    sdk,
    holders,
    relay,
    clock,
    home,
    exits,
    startError: null,
    async start() {
      try {
        await real(kernel.start(), "start Host");
      } catch (e) {
        if (!(e instanceof StartError)) throw e;
        st.startError = e;
      }
    },
    host(name) {
      const m = kernel.byName.get(name);
      if (!m) throw new Error(`модуля ${name} нет`);
      return kernel.hostFacade(m);
    },
    session(name, callsign) {
      return st.host(name).session(callsign);
    },
    async open(callsign, oo = {}) {
      const s = await real(kernel.open({ callsign, cwd: oo.cwd ?? join(home, "work", nameOf(callsign)), ...(oo.opening ? { opening: oo.opening } : {}), ...(oo.mkdir ? { mkdir: true } : {}) }), `open ${callsign}`);
      const m = oo.module ? kernel.byName.get(oo.module) : undefined;
      return s.facade(m ?? standMod);
    },
    proc(callsign) {
      const p = holders.procs.get(callsign);
      if (!p) throw new Error(`процесса ${callsign} нет у держателей`);
      return p;
    },
    query(callsign) {
      const q = sdk.last(callsign);
      if (!q) throw new Error(`query() сессии ${callsign} нет`);
      return q;
    },
    journal() {
      const dir = join(home, "journal");
      if (!existsSync(dir)) return [];
      return readdirSync(dir)
        .filter((f) => f.startsWith("host-"))
        .flatMap((f) => readFileSync(join(dir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)));
    },
    states(callsign) {
      return relay.frames("session.state").filter((f) => f.callsign === callsign);
    },
    crash() {
      crashed = true;
      kernel.holders.close();
      kernel.relay?.close(1000, "killed");
    },
    async close() {
      if (crashed) return;
      if (!kernel.shutting) await kernel.shutdown("upgrade");
      else await kernel.shutting;
      if (!o.holders) await holders.close();
    },
  };
  if (o.start !== false) await st.start();
  return st;
}
