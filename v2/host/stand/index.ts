// Стенд Host: настоящее ядро на поддельных SDK, связи, службах, держателях и часах. Хранилище и журнал — во временной папке.
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fail, isReply, newId, ok, type Frame, type Link, type LinkState, type LogLine, type Reply, type Transport } from "@sb/protocol";
import type { Module } from "../src/core/contract.ts";
import { Kernel, StartError } from "../src/core/kernel.ts";
import type { Session } from "../src/core/session.ts";
import type { CoreRecord } from "../src/core/store.ts";
import { FakeClock } from "./clock.ts";
import { FakeHolders, type FakeProc } from "./holders.ts";
import { FakeSdk, type FakeQuery } from "./sdk.ts";

export { FakeClock, FakeHolders, FakeSdk, StartError };
export type { FakeProc, FakeQuery };

/** Подождать, пока условие станет истинным: шагами цикла событий, не дольше ms настоящего времени. */
export async function until<T>(cond: () => T | undefined | null | false, ms = 5000, what = "условие"): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = cond();
    if (v) return v;
    if (Date.now() > end) throw new Error(`стенд: не дождался — ${what}`);
    await new Promise((r) => setImmediate(r));
  }
}
export const tick = (n = 5) => until(() => --n < 0);

/** Поддельное соединение с объектом машины. */
export class FakeLink {
  sent: Frame[] = [];
  state: LinkState = "closed";
  private onFrame: (f: Frame) => void = () => {};
  private onState: (s: LinkState) => void = () => {};
  private waits = new Map<string, (r: Reply) => void>();
  /** ответы на запросы Host другим машинам: имя запроса → ответ */
  answers: Record<string, (f: Frame) => Reply | undefined> = {};

  connect = (o: { onFrame: (f: Frame) => void; onState: (s: LinkState) => void }): Link => {
    this.onFrame = o.onFrame;
    this.onState = o.onState;
    queueMicrotask(() => this.open());
    return {
      send: (f) => {
        this.sent.push(f);
        if (isReply(f)) return void this.waits.get(f.id)?.(f);
        const answer = f.id ? this.answers[f.type]?.(f) : undefined;
        if (answer) queueMicrotask(() => this.onFrame(answer));
      },
      close: () => void (this.state = "closed"),
    };
  };

  open(): void {
    this.state = "open";
    this.onState("open");
    this.onFrame({ type: "hello.ok", addr: "@laptop" });
  }
  drop(): void {
    this.state = "closed";
    this.onState("closed");
  }
  stop(): void {
    this.state = "stopped";
    this.onState("stopped");
  }
  /** Кадр от объекта машины. */
  deliver(f: Frame): void {
    this.onFrame(f);
  }
  /** Запрос от объекта машины: ждёт reply Host. */
  request(type: string, fields: Record<string, unknown> = {}, from = "pult~yuri@example.com"): Promise<Reply> {
    const id = newId("q");
    return new Promise((res) => {
      this.waits.set(id, res);
      this.onFrame({ ...fields, type, id, from, trace: newId("t") });
    });
  }
  of(type: string): Frame[] {
    return this.sent.filter((f) => f.type === type);
  }
  /** Изменения строки сессии, ушедшие в картину. */
  rows(callsign: string): Frame[] {
    return this.sent.filter((f) => f.type === "session.state" && f.callsign === callsign);
  }
}

/** Поддельные службы: POST /call. */
export class FakeServices implements Transport {
  calls: Frame[] = [];
  /** имя запроса → результат или отказ */
  handlers: Record<string, (f: Frame) => unknown> = {};
  call = async (f: Frame): Promise<Reply> => {
    this.calls.push(f);
    const h = this.handlers[f.type];
    try {
      return ok(f.id!, h ? await h(f) : {});
    } catch (e) {
      const r = e as { word?: string; why?: string; message: string };
      return fail(f.id!, r.word ?? "module_failed", r.why ?? r.message);
    }
  };
  open = (): Link => ({ send() {}, close() {} });
  of(type: string): Frame[] {
    return this.calls.filter((f) => f.type === type);
  }
}

export type StandOptions = {
  modules?: Module[];
  machine?: string;
  /** core.json до старта: сессии прежнего Host */
  sessions?: Array<Partial<CoreRecord> & { callsign: string }>;
  /** папка данных — та же между перезапусками Host */
  home?: string;
  /** держатели — те же между перезапусками Host */
  holders?: FakeHolders;
  sdkVersion?: string;
  config?: Record<string, unknown>;
  /** стартовать сразу; по умолчанию да */
  start?: boolean;
};

export type Stand = {
  kernel: Kernel;
  sdk: FakeSdk;
  holders: FakeHolders;
  link: FakeLink;
  services: FakeServices;
  clock: FakeClock;
  home: string;
  /** рабочая папка для сессий стенда */
  dir: string;
  exits: number[];
  error?: StartError;
  /** строки журнала Host */
  journal(): LogLine[];
  /** запрос от страницы через соединение */
  request(type: string, fields?: Record<string, unknown>, from?: string): Promise<Reply>;
  /** открыть сессию и дождаться готовности */
  open(name: string, spec?: Record<string, unknown>, from?: string): Promise<{ s: Session; proc: FakeProc; q: FakeQuery }>;
  proc(callsign: string): FakeProc;
  /** ход: занята → события → итог → свободна */
  turn(callsign: string, events?: Array<Record<string, unknown>>, result?: string): Promise<void>;
  stop(): Promise<void>;
};

export async function stand(o: StandOptions = {}): Promise<Stand> {
  const home = o.home ?? mkdtempSync(join(tmpdir(), "sb2-host-"));
  const dir = join(home, "work");
  mkdirSync(dir, { recursive: true });
  const machine = o.machine ?? "laptop";
  if (o.sessions) {
    mkdirSync(join(home, "store"), { recursive: true });
    const recs = o.sessions.map((r) => ({ spec: { name: r.callsign.split("@")[0], cwd: dir }, cwd: dir, sessionId: `sid-${r.callsign}`, sdk: o.sdkVersion ?? "0.3.321", stopped: false, by: "pult~yuri@example.com", since: 1, ...r }));
    writeFileSync(join(home, "store", "core.json"), JSON.stringify({ sessions: recs }));
  }
  const sdk = new FakeSdk(o.sdkVersion ?? "0.3.321");
  const holders = o.holders ?? new FakeHolders();
  const link = new FakeLink();
  const services = new FakeServices();
  const clock = new FakeClock();
  const exits: number[] = [];
  const kernel = new Kernel({
    home, machine, fleet: "home", base: "https://fleet.test", key: "home:k00001:0123456789abcdef0123", build: 1, sdkVersion: sdk.version,
    modules: o.modules ?? [], sdk: sdk as never, holders, config: o.config, connect: link.connect, transport: services, clock, exit: (c) => void exits.push(c),
  });
  const st: Stand = {
    kernel, sdk, holders, link, services, clock, home, dir, exits,
    journal() {
      const j = join(home, "journal");
      if (!existsSync(j)) return [];
      return readdirSync(j).flatMap((f) => readFileSync(join(j, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as LogLine));
    },
    request: (type, fields, from) => link.request(type, fields, from),
    async open(name, spec = {}, from) {
      const r = await link.request("session.open", { to: `@${machine}`, spec: { name, cwd: dir, ...spec } }, from);
      if (!r.ok) throw new Error(`session.open ${name}: ${r.error} ${r.why ?? ""}`);
      const callsign = `${name}@${machine}`;
      return { s: kernel.sessions.get(callsign)!, proc: holders.procs.get(callsign)!, q: sdk.last(callsign)! };
    },
    proc: (callsign) => holders.procs.get(callsign)!,
    async turn(callsign, events = [], result = "готово") {
      const p = holders.procs.get(callsign)!;
      const s = kernel.sessions.get(callsign)!;
      p.send({ type: "system", subtype: "session_state_changed", state: "running", session_id: "s" });
      await until(() => s.state === "busy", 5000, `${callsign} busy`);
      for (const e of events) p.send(e);
      p.send({ type: "result", subtype: "success", result, session_id: "s" });
      p.send({ type: "system", subtype: "session_state_changed", state: "idle", session_id: "s" });
      await until(() => s.state === "idle", 5000, `${callsign} idle`);
    },
    async stop() {
      if (!kernel.shutting) await kernel.shutdown("стенд");
      await holders.close();
    },
  };
  if (o.start !== false) {
    try {
      await kernel.start();
    } catch (e) {
      if (!(e instanceof StartError)) throw e;
      st.error = e;
    }
  }
  return st;
}
