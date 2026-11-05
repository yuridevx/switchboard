// Связь с relay и маршрут: кадр из relay — владельцу по type, запрос — владельцу с проверками и reply, host.request и host.emit модуля.
// Сам ничего не решает: находит владельца и передаёт ему.
import { randomUUID } from "node:crypto";
import { READ_MS, accepts, fail, hostOf, isReply, kindOf, ok, serviceAddress } from "@switchboard/protocol";
import type { Frame, Reply } from "@switchboard/protocol";
import { fleet } from "@switchboard/relay";
import type { FleetClient, LinkState, Roster, WsCtor } from "@switchboard/relay";
import type { Ctx, Host, LogRecord, Result } from "../contract.ts";
import type { Clock } from "./clock.ts";
import { isRefusal } from "./refusal.ts";
import { nameOf, ownerOf } from "./registry.ts";
import type { Sess } from "./session.ts";
import { MODULE_ERROR } from "./trap.ts";
import type { Mod, Scope, Trap } from "./trap.ts";

const SKIP = Symbol("skip");

/** Причина отказа из ответа, если владелец её назвал. */
const whyOf = (r: Reply) => {
  const why = (r as { why?: unknown }).why;
  return typeof why === "string" ? { why } : {};
};

/** Имя глазами модуля: своё из provides или чужое из uses; его версия и владелец. */
export function refOf(m: Mod, name: string): { owner: string; version: number; own: boolean } | null {
  const own = m.manifest.provides?.[name];
  if (own !== undefined) return { owner: m.name, version: own, own: true };
  const ref = Object.keys(m.manifest.uses ?? {}).find((r) => nameOf(r) === name);
  return ref ? { owner: ownerOf(ref), version: m.manifest.uses[ref], own: false } : null;
}

export type RouterDeps = {
  trap: Trap;
  clock: Clock;
  machine: string;
  workers: Record<string, string>;
  relayKey?: string;
  sdkVersion: string;
  WebSocket?: WsCtor;
  fetch?: typeof fetch;
  pingMs?: number;
  pauseMs?: number;
  signal: AbortSignal;
  sessions: Map<string, Sess>;
  log(rec: LogRecord): void;
  /** строка журнала от имени модуля */
  logAs(who: string, rec: LogRecord): void;
  host(m: Mod): Host;
  /** contract в hello: provides всех модулей */
  contract(): Record<string, number>;
  /** Host останавливается: новое не принимаем */
  stopping(): boolean;
  /** пропуск не приняли: чистый перезапуск */
  shutdown(reason: string): void;
};

export class Router {
  relay: FleetClient | null = null;
  /** последний roster от relay — модули берут его через host.roster() */
  roster: Roster | null = null;
  /** начатые запросы: остановка Host их дожидается */
  readonly inflight = new Set<Promise<unknown>>();
  private readonly d: RouterDeps;
  private readonly requests = new Map<string, Mod>();
  private readonly frames = new Map<string, Mod>();
  private seq = 0;
  private readonly idPrefix = randomUUID().slice(0, 8);

  constructor(d: RouterDeps) {
    this.d = d;
  }

  /** Владельцы запросов и кадров по загруженным модулям. */
  index(mods: Mod[]): void {
    for (const m of mods) {
      for (const n of Object.keys(m.module.requests ?? {})) this.requests.set(n, m);
      for (const n of Object.keys(m.module.frames ?? {})) this.frames.set(n, m);
    }
  }

  connect(): void {
    const { workers, relayKey, machine, sdkVersion, sessions, contract, log, WebSocket, fetch, pingMs, pauseMs, stopping } = this.d;
    if (!workers.relay || stopping()) return;
    this.relay = fleet({
      workers,
      key: relayKey ?? "",
      machine,
      hello: () => ({ sdk: sdkVersion, contract: contract(), sessions: [...sessions.values()].map((s) => s.helloRecord()) }),
      onFrame: (f) => this.onFrame(f),
      // своя машина — связь Host; другие — гостевые соединения, строка журнала; "" — список машин у gate
      onState: (m, st, why) => (m === machine ? this.onLink(st, why) : log({ ev: `guest_${st}`, why: `${m || "keys.list"}${why ? " · " + why : ""}` })),
      onLost: (f, word) => log({ kind: "note", ev: f.type, word, why: `${f.type} → ${String(f.to)} не дошёл: ${word}` }),
      WebSocket,
      fetch,
      pingMs,
      pauseMs,
    });
  }

  private onLink(st: LinkState, why?: string): void {
    const { log, sessions, shutdown } = this.d;
    if (st === "stopped") {
      if (why === "shutting_down") return;
      log({ kind: "stop", ev: "relay_stopped", word: why, why: `relay закрыл соединение: ${why} — Host не переподключается` });
      // пропуск в памяти больше не принимают: чистый перезапуск — keeper поднимет Host с нынешним machine.key; не примут и его — второе падение, failed
      if (why === "revoked" || why === "bad_key") shutdown(`relay не принял пропуск машины: ${why}`);
    } else if (st === "closed") log({ ev: "relay_closed", why: why ?? "" });
    else if (st === "open") {
      log({ ev: "hello", why: "hello принят" });
      for (const s of sessions.values()) s.push();
    }
  }

  /** Кадр в relay; связи нет — disconnected, больше предела кадра — too_large (слово ставит клиент рации). */
  send(f: Frame): Result {
    return this.relay?.send(f) ?? { ok: false, error: "disconnected" };
  }

  private ctx(m: Mod, from?: string): Ctx {
    return { host: this.d.host(m), from, signal: this.d.signal };
  }

  /** Кадр из relay: запрос — владельцу по type; кадр — владельцу или в on.frame тем, у кого имя в uses. */
  private onFrame(f: Frame): void {
    const { trap, log, stopping } = this.d;
    if (isReply(f)) return; // ответ без ждущего: link свои уже разобрал
    if (typeof f.id === "string") {
      const answer = this.handleRequest(f as Frame & { id: string }).then((r) => void this.send(f.from ? { ...r, to: f.from } : r));
      this.inflight.add(answer);
      void answer.finally(() => this.inflight.delete(answer));
      return;
    }
    const owner = this.frames.get(f.type);
    if (owner) {
      if (stopping()) return;
      void trap.call(owner, `frames.${f.type}`, this.frameSession(f), (x) => x.frames![f.type](f, this.ctx(owner, f.from)), () => undefined);
      return;
    }
    // roster флота — объединение roster объектов машин; держит ядро, модули, которым он нужен событием, получают его как кадр
    if (f.type === "roster") f = (this.roster = this.relay?.roster ?? (f as Roster)) as unknown as Frame;
    let got = f.type === "roster";
    for (const m of trap.mods) {
      if (!m.module.on?.frame || !Object.keys(m.manifest.uses ?? {}).some((r) => nameOf(r) === f.type)) continue;
      got = true;
      void trap.call(m, "on.frame", null, (x) => x.on!.frame!(f), () => undefined);
    }
    if (!got) log({ kind: "refuse", ev: "frame", word: "unknown_request", why: `кадр ${f.type}: владельца нет` });
  }

  private frameSession(f: Frame): Scope | null {
    const name = typeof f.callsign === "string" ? f.callsign : typeof f.to === "string" ? f.to : null;
    return (name && this.d.sessions.get(name)) || null;
  }

  /** Запрос владельцу: проверки ядра, вызов в ловушке, reply. */
  private async handleRequest(f: Frame & { id: string }): Promise<Reply> {
    const { trap, log, sessions, stopping } = this.d;
    if (stopping()) {
      log({ kind: "refuse", ev: "request", word: "shutting_down", id: f.id, type: f.type, from: f.from });
      return fail(f.id, "shutting_down");
    }
    // имя обслуживается и версия совпадает — одно правило с участниками рации
    const owner = this.requests.get(f.type);
    const bad = accepts(f, owner ? { [f.type]: owner.manifest.provides[f.type] } : {});
    if (bad || !owner) {
      log({ kind: "refuse", ev: "request", word: bad!.word, id: f.id, from: f.from, why: owner ? `${bad!.why} (${owner.name})` : bad!.why });
      return fail(f.id, bad!.word);
    }
    let s: Sess | null = null;
    if (typeof f.callsign === "string") {
      s = sessions.get(f.callsign) ?? null;
      // запрос о сессии, которой нет: адресата нет, обработчик не вызывается
      if (!s) {
        log({ kind: "refuse", ev: "request", word: "offline", id: f.id, from: f.from, why: `${f.type}: сессии ${f.callsign} нет на машине` });
        return fail(f.id, "offline");
      }
    }
    try {
      const r = await trap.call<unknown>(owner, `requests.${f.type}`, s, (x) => x.requests![f.type](f, this.ctx(owner, f.from)), () => SKIP);
      if (r === SKIP) {
        log({ kind: "refuse", ev: "request", word: MODULE_ERROR, id: f.id, from: f.from, module: owner.name, why: `${f.type}: модуль ${owner.name} выключен${s ? " в " + s.callsign : ""}` });
        return fail(f.id, MODULE_ERROR);
      }
      return ok(f.id, r);
    } catch (e) {
      if (!isRefusal(e)) throw e;
      this.d.logAs(owner.name, { kind: "refuse", ev: "request", word: e.word, id: f.id, from: f.from, why: e.why ?? `${f.type}: ${e.word}` });
      // причина — в ответ: и через relay, и на своей машине; так уже отвечают службы флота
      return { ...fail(f.id, e.word), ...(e.why ? { why: e.why } : {}) } as Reply;
    }
  }

  /** host.request и host.read: имя из uses или своё; владелец — модуль этой машины или через relay: другая машина, часть машины, служба. */
  async request(m: Mod, name: string, payload: Record<string, unknown>, read = false): Promise<Result> {
    const { trap, machine, workers } = this.d;
    const ref = refOf(m, name);
    if (!ref) return trap.violation(m, trap.callerOf(m), `${name} нет в uses`);
    // версия — из своих provides или uses модуля, если вызов её не назвал
    if (payload.v === undefined) payload = { ...payload, v: ref.version };
    const target = hostOf(payload) ?? null;
    if (trap.byName.has(ref.owner) && (target === null || target === machine) && !(payload.to && typeof payload.to !== "string")) {
      const id = `${this.idPrefix}-${++this.seq}`;
      // отправитель — как через relay: from запроса, иначе машина; владелец видит его в ctx.from и не выбирает сам
      const from = kindOf(payload.from) ? (payload.from as string) : `@${machine}`;
      const answer = this.handleRequest({ ...payload, type: name, id, from } as Frame & { id: string });
      const r = read ? await this.readLimit(answer, id) : await answer;
      return r.ok ? { ok: true, result: r.result } : { ok: false, error: r.error, ...whyOf(r) };
    }
    if (!this.relay) return { ok: false, error: "disconnected" };
    const frame: Frame = { ...payload, type: name };
    // владелец — Worker флота (есть в адресах сборки) — .имя, даже если в запросе есть поля machine или callsign;
    // keeper машины адресуется явно: .keeper@машина
    if (workers[ref.owner] && payload.to === undefined) frame.to = serviceAddress(ref.owner);
    // отказ несёт все поля reply владельца (missing, owner, creds…), без конверта
    const { type: _t, id: _i, to: _to, from: _f, ...r } = (await this.relay.request(frame, read)) as Frame & Reply;
    return r as Result;
  }

  /** Предел чтения на своей машине — по часам ядра; обработчик работает дальше, его ответ отброшен. */
  private readLimit(answer: Promise<Reply>, id: string): Promise<Reply> {
    const { clock } = this.d;
    let t: unknown;
    const late = new Promise<Reply>((done) => (t = clock.setTimeout(() => done(fail(id, "timeout")), READ_MS)));
    return Promise.race([answer, late]).finally(() => clock.clearTimeout(t));
  }

  /** host.emit: кадр без ответа; type — свой или из uses. Связи нет — disconnected, очереди нет; больше предела кадра — too_large. */
  emit(m: Mod, f: Frame): Result {
    const { trap } = this.d;
    const ref = refOf(m, f.type);
    if (!ref) return trap.violation(m, trap.callerOf(m), `${f.type} нет в provides и uses`);
    // версия — как у request: из provides или uses, если кадр её не назвал
    return this.send(f.v === undefined ? { ...f, v: ref.version } : f);
  }
}
