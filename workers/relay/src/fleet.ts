// Объект флота: соединения и их карточки, hello через gate, roster, доставка по адресу, from.
// На диск не пишет: всё о флоте — в карточках живых соединений и в ответах hello() участников.
import { DurableObject } from "cloudflare:workers";
import { fail, kindOf, machineOf, parseFrame, serviceAddress } from "@switchboard/protocol";
import type { Frame } from "@switchboard/protocol";
import type { GateApi, VerifyResult } from "@switchboard/gate";
import type { Participant, ParticipantHello, RelayWord, Roster, SessionRecord } from "../contract.ts";

export type Env = {
  FLEET: DurableObjectNamespace<Fleet>;
  GATE: GateApi;
  /** версии контракта relay, которые принимает hello */
  PROTO: number[];
  /** имя участника → имя его привязки */
  PARTICIPANTS: Record<string, string>;
  /** email владельца флота: клиентские ключи пока выданы ему — адрес устройства устройство~email */
  OWNER: string;
};

/** Один объект на флот. */
export const FLEET = "home";
/** Предел карточки соединения у Cloudflare. */
export const CARD_LIMIT = 16_384;
/** Имена relay: из них по сети разбирается только session.state; hello — первым кадром. */
const OWN = new Set(["hello", "roster", "session.state", "frame"]);
const ROSTER_V = 1;

type HostCard = {
  role: "host";
  name: string;
  kid: string;
  since: number;
  proto: number;
  sdk?: string;
  contract?: Record<string, number>;
  sessions: SessionRecord[];
};
type ClientCard = { role: "client"; name: string; kid: string; since: number; proto: number };
/** часть машины (keeper): входит ключом машины с part в hello; в roster не входит, адрес .part@машина */
type KeeperCard = { role: "keeper"; name: string; kid: string; since: number; proto: number };
type Card = HostCard | ClientCard | KeeperCard;
type Sender = { ws: WebSocket; card: Card } | { worker: string };

const log = (line: string) => console.log(line);
const enc = new TextEncoder();
const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const cardOf = (ws: WebSocket) => ws.deserializeAttachment() as Card | null;
/** role.name.kid ключа — без подписи: подпись в журнал не попадает. */
const keyId = (key: string) => key.split(".").slice(0, 3).join(".").slice(0, 80);
/** Номер ключа соединения role.name.kid: keeper входит ключом машины — его ключ host.<машина>.<kid>. */
const keyOf = (c: Card) => `${c.role === "keeper" ? "host" : c.role}.${c.name}.${c.kid}`;
/** callsign сессии этой машины: site@laptop; голый @laptop — не сессия. */
const ownCallsign = (cs: unknown, machine: string) => typeof cs === "string" && cs.indexOf("@") > 0 && machineOf(cs) === machine;

export class Fleet extends DurableObject<Env> {
  /** участники, ответившие на hello(); память объекта — спрашиваются заново на каждом старте */
  private workers = new Map<string, ParticipantHello>();
  private ready: Promise<void>;
  /** соединения, чей hello сейчас проверяет gate */
  private verifying = new Set<WebSocket>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // ping → pong отвечает Cloudflare, объект не просыпается
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    this.ready = this.helloParticipants().then(() => this.recheck());
  }

  async fetch(): Promise<Response> {
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, msg: string | ArrayBuffer): Promise<void> {
    let type = "?";
    try {
      await this.ready;
      const text = typeof msg === "string" ? msg : "";
      const f = parseFrame(text);
      if (f) type = f.type;
      const card = cardOf(ws);
      if (!card) {
        if (this.verifying.has(ws) || !f || f.type !== "hello") {
          log(`bad_frame до hello · ${type}`);
          return ws.close(1008, "bad_frame");
        }
        return await this.hello(ws, f);
      }
      if (!f) {
        log(`bad_frame ${card.role}.${card.name} · не кадр`);
        const id = idOf(text);
        if (id) ws.send(JSON.stringify(fail(id, "bad_frame")));
        return;
      }
      const word = await this.route({ ws, card }, f);
      if (word && f.id) ws.send(JSON.stringify(fail(f.id, word)));
    } catch (e) {
      this.crash(e, `webSocketMessage(${type})`);
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      await this.ready;
      const card = cardOf(ws);
      if (!card) return;
      log(`close ${card.role}.${card.name} · ${code}${reason ? " " + reason : ""}`);
      // keeper в roster не входит: его уход roster не меняет
      if (card.role !== "keeper") await this.broadcast(ws);
    } catch (e) {
      this.crash(e, "webSocketClose");
    }
  }

  async webSocketError(ws: WebSocket, err: unknown): Promise<void> {
    const card = cardOf(ws);
    log(`error ${card ? `${card.role}.${card.name}` : "до hello"} · ${err}`);
  }

  /** Кадр участника: вход Radio передаёт его сюда с именем из props привязки. */
  async radio(name: string, raw: unknown): Promise<RelayWord | undefined> {
    try {
      await this.ready;
      if (!name) {
        log("bad_from участник без props.name");
        return "bad_from";
      }
      const f = parseFrame(JSON.stringify(raw ?? null));
      if (!f) {
        log(`bad_frame ${name} · не кадр`);
        return "bad_frame";
      }
      return await this.route({ worker: name }, f);
    } catch (e) {
      this.crash(e, `radio(${name})`);
    }
  }

  // ---------- hello ----------

  private async hello(ws: WebSocket, f: Frame): Promise<void> {
    const key = typeof f.key === "string" ? f.key : "";
    let r: VerifyResult;
    this.verifying.add(ws);
    try {
      r = await call(this.env.GATE.verify(key));
    } catch (e) {
      log(`gate ${keyId(key)} · gate_unavailable · ${e}`);
      return ws.close(1008, "gate_unavailable");
    } finally {
      this.verifying.delete(ws);
    }
    if (ws.readyState !== 1) return; // ушёл, пока gate проверял
    if ("error" in r) {
      log(`${r.error} ${keyId(key)}`);
      return ws.close(1008, r.error);
    }
    const id = `${r.role}.${r.name}.${r.kid}`;
    if (typeof f.proto !== "number" || !this.env.PROTO.includes(f.proto)) {
      log(`contract_mismatch ${id} · proto ${JSON.stringify(f.proto)} · relay ${JSON.stringify(this.env.PROTO)}`);
      return ws.close(1008, "contract_mismatch");
    }
    let card: Card;
    const since = Date.now();
    // часть машины входит ключом машины; в рацию из частей выходит только keeper
    if (f.part !== undefined && !(r.role === "host" && f.part === "keeper")) {
      log(`bad_frame ${id} · part ${JSON.stringify(f.part)} — в рацию входит только keeper ключом машины`);
      return ws.close(1008, "bad_frame");
    }
    if (f.part === "keeper") {
      card = { role: "keeper", name: r.name, kid: r.kid, since, proto: f.proto };
    } else if (r.role === "host") {
      const sessions = f.sessions ?? [];
      if (!Array.isArray(sessions) || !sessions.every((s) => isObj(s) && ownCallsign(s.callsign, r.name))) {
        log(`bad_from ${id} · в hello callsign не машины ${r.name}`);
        return ws.close(1008, "bad_from");
      }
      card = {
        role: "host",
        name: r.name,
        kid: r.kid,
        since,
        proto: f.proto,
        sdk: typeof f.sdk === "string" ? f.sdk : undefined,
        contract: isObj(f.contract) ? (f.contract as Record<string, number>) : undefined,
        sessions: sessions as SessionRecord[],
      };
    } else {
      card = { role: "client", name: r.name, kid: r.kid, since, proto: f.proto };
    }
    const size = enc.encode(JSON.stringify(card)).length;
    if (size > CARD_LIMIT) {
      log(`bad_frame ${id} · карточка ${size} байт · предел ${CARD_LIMIT}`);
      return ws.close(1008, "bad_frame");
    }
    if (card.role === "host" || card.role === "keeper") {
      for (const s of this.live()) {
        const c = cardOf(s)!;
        if (s !== ws && c.role === card.role && c.name === card.name) {
          log(`replaced ${c.role}.${c.name}.${c.kid}`);
          s.close(1000, "replaced");
        }
      }
    }
    ws.serializeAttachment(card);
    log(`hello ${id} · proto ${card.proto}${card.role === "host" ? ` · ${card.sessions.length} сессий` : ""}`);
    // keeper в roster не входит: roster — только ему, как знак, что hello принят; флот не меняется
    if (card.role === "keeper") ws.send(JSON.stringify(this.roster()));
    else await this.broadcast();
  }

  // ---------- кадр после hello: один порядок для соединений и участников ----------

  private async route(s: Sender, f: Frame): Promise<RelayWord | undefined> {
    const refuse = (word: RelayWord, why: string): RelayWord => {
      log(`${word} ${this.who(s)} · ${f.type}${why ? " · " + why : ""}`);
      return word;
    };

    // from ставит relay по ключу или привязке: участник — .имя, keeper — .keeper@машина, клиент — устройство~email;
    // Host — сама машина или сессия этой машины
    let from: string;
    if ("worker" in s || s.card.role !== "host") {
      const own = this.who(s);
      if (f.from !== undefined && f.from !== own) return refuse("bad_from", `from=${String(f.from)}`);
      from = own;
    } else {
      const k = kindOf(f.from);
      if (f.from !== undefined && (!(k === "session" || k === "machine") || machineOf(f.from as string) !== s.card.name)) {
        return refuse("bad_from", `from=${String(f.from)}`);
      }
      from = (f.from as string | undefined) ?? `@${s.card.name}`;
    }

    if (OWN.has(f.type)) {
      if (f.type !== "session.state") return refuse("bad_frame", "имя relay");
      return this.sessionState(s, f, refuse);
    }

    const out: Frame = { ...f, from };
    if (f.to !== undefined) {
      const list = Array.isArray(f.to) ? f.to : [f.to];
      if (Array.isArray(f.to) && f.id !== undefined) return refuse("bad_frame", "to списком у кадра с id");
      if (!list.length || !list.every((a) => kindOf(a) !== null)) return refuse("bad_frame", `to не адрес: ${JSON.stringify(f.to)}`);
      let n = 0;
      for (const a of list) n += await this.deliver(a, out, this.who(s));
      return n ? undefined : refuse("offline", `→ ${list.join(",")}`);
    }
    const m = typeof f.callsign === "string" ? machineOf(f.callsign) : typeof f.machine === "string" ? f.machine : undefined;
    if (m === undefined) return refuse("bad_frame", "нет адреса");
    if (!m) return refuse("bad_frame", `callsign ${String(f.callsign)}`);
    const host = this.hostOf(m);
    if (!host) return refuse("offline", `→ @${m}`);
    host.send(JSON.stringify(out));
    return undefined;
  }

  private async sessionState(s: Sender, f: Frame, refuse: (w: RelayWord, why: string) => RelayWord): Promise<RelayWord | undefined> {
    if ("worker" in s || s.card.role !== "host") return refuse("bad_from", "session.state не от Host");
    const card = s.card;
    if (!ownCallsign(f.callsign, card.name)) return refuse("bad_from", `callsign ${String(f.callsign)}`);
    // запись сессии — кадр без конверта; заменяется целиком, state: null убирает её
    const { type: _t, id: _i, v: _v, from: _f, to: _to, ...rec } = f;
    const sessions = card.sessions.filter((x) => x.callsign !== f.callsign);
    if (f.state !== null) {
      const at = card.sessions.findIndex((x) => x.callsign === f.callsign);
      sessions.splice(at < 0 ? sessions.length : at, 0, rec as SessionRecord);
    }
    const next: HostCard = { ...card, sessions };
    const size = enc.encode(JSON.stringify(next)).length;
    if (size > CARD_LIMIT) return refuse("bad_frame", `карточка ${size} байт · предел ${CARD_LIMIT}`);
    s.ws.serializeAttachment(next);
    await this.broadcast();
    return undefined;
  }

  /** Доставить по одному адресу по его виду; ответ — сколько получателей. */
  private async deliver(a: string, out: Frame, sender: string): Promise<number> {
    const text = JSON.stringify(out);
    switch (kindOf(a)) {
      case "machine":
      case "session": {
        const m = machineOf(a);
        const host = m ? this.hostOf(m) : undefined;
        if (!host) return 0;
        // callsign — только если он есть в карточке машины; @машина — сама машина
        if (!a.startsWith("@") && !(cardOf(host) as HostCard).sessions.some((x) => x.callsign === a)) return 0;
        host.send(text);
        return 1;
      }
      case "part": {
        const m = machineOf(a);
        const name = a.slice(1, a.indexOf("@"));
        const ws = this.live().find((x) => {
          const c = cardOf(x)!;
          return name === "keeper" && c.role === "keeper" && c.name === m;
        });
        if (!ws) return 0;
        ws.send(text);
        return 1;
      }
      case "device":
      case "user": {
        let n = 0;
        for (const ws of this.live()) {
          const c = cardOf(ws)!;
          if (c.role !== "client") continue;
          const addr = this.clientAddress(c.name);
          if (addr === a || (a.startsWith("~") && addr.endsWith(a))) {
            ws.send(text);
            n++;
          }
        }
        return n;
      }
      case "service": {
        const name = a.slice(1);
        if (!this.workers.has(name)) return 0;
        try {
          await call(this.participant(name).frame(out));
          return 1;
        } catch (e) {
          log(`offline ${sender} → ${a} · ${out.type} · frame: ${e}`);
          return 0;
        }
      }
      default:
        return 0;
    }
  }

  /** Адрес устройства клиента: ключи клиентов пока выданы владельцу флота. */
  private clientAddress(name: string): string {
    return `${name}~${this.env.OWNER}`;
  }

  /** Адрес отправителя — по ключу или привязке. */
  private who(s: Sender): string {
    if ("worker" in s) return serviceAddress(s.worker);
    switch (s.card.role) {
      case "host":
        return `@${s.card.name}`;
      case "keeper":
        return `.keeper@${s.card.name}`;
      default:
        return this.clientAddress(s.card.name);
    }
  }

  // ---------- roster ----------

  /** Живые соединения с принятым hello. */
  private live(except?: WebSocket): WebSocket[] {
    return this.ctx.getWebSockets().filter((s) => s !== except && s.readyState === 1 && cardOf(s));
  }

  private hostOf(machine: string): WebSocket | undefined {
    return this.live().find((s) => {
      const c = cardOf(s)!;
      return c.role === "host" && c.name === machine;
    });
  }

  roster(except?: WebSocket): Roster {
    const r: Roster = { type: "roster", machines: [], sessions: [], clients: [], workers: [] };
    for (const s of this.live(except)) {
      const c = cardOf(s)!;
      if (c.role === "host") {
        r.machines.push({ machine: c.name, since: c.since, proto: c.proto, sdk: c.sdk, contract: c.contract });
        r.sessions.push(...c.sessions);
      } else if (c.role === "client" && !r.clients.includes(this.clientAddress(c.name))) r.clients.push(this.clientAddress(c.name));
    }
    for (const [name, h] of this.workers) r.workers.push({ name, contract: h.contract });
    return r;
  }

  /** roster — всем соединениям и участникам, у кого roster@relay в uses. */
  private async broadcast(except?: WebSocket): Promise<void> {
    const r = this.roster(except);
    const text = JSON.stringify(r);
    // keeper roster не читает: ему — только первый, при входе
    for (const s of this.live(except)) if (cardOf(s)!.role !== "keeper") s.send(text);
    const calls: Promise<void>[] = [];
    for (const [name, h] of this.workers) {
      const v = h.uses?.["roster@relay"];
      if (v === undefined) continue;
      if (v !== ROSTER_V) {
        log(`contract_mismatch ${name} · roster@relay v${v} · relay v${ROSTER_V}`);
        continue;
      }
      calls.push(
        (async () => {
          try {
            await call(this.participant(name).frame(r));
          } catch (e) {
            log(`offline relay → ${name} · roster · frame: ${e}`);
          }
        })(),
      );
    }
    await Promise.all(calls);
  }

  // ---------- участники ----------

  private participant(name: string): Participant {
    return (this.env as unknown as Record<string, Participant>)[this.env.PARTICIPANTS[name]];
  }

  /** hello() каждого участника из PARTICIPANTS при старте объекта. Не ответил — его нет в roster. */
  private async helloParticipants(): Promise<void> {
    await Promise.all(
      Object.entries(this.env.PARTICIPANTS ?? {}).map(async ([name, binding]) => {
        const b = (this.env as unknown as Record<string, Participant | undefined>)[binding];
        if (!b) return log(`worker ${name} · привязки ${binding} нет`);
        try {
          const h = await call(b.hello());
          if (!isObj(h) || !isObj(h.contract)) throw new Error("hello() без contract");
          this.workers.set(name, { contract: h.contract, uses: isObj(h.uses) ? h.uses : undefined });
          log(`worker ${name} · ${Object.entries(h.contract).map(([k, v]) => `${k} ${v}`).join(", ")}`);
        } catch (e) {
          log(`worker ${name} · hello: ${e}`);
        }
      }),
    );
  }

  /**
   * Старт объекта: отозванные ключи открытых соединений — закрыть словом revoked. Выпуск relay спящие
   * веб-сокеты не рвёт (факт живого прогона 31 окт.), поэтому отзыв проверяется здесь, а не только в hello.
   * gate не ответил — соединения живут, строка в журнале: проверит следующий старт.
   */
  private async recheck(): Promise<void> {
    const open = this.live().map((ws) => ({ ws, card: cardOf(ws)! }));
    if (!open.length) return;
    let gone: string[];
    try {
      gone = await call(this.env.GATE.revoked(open.map((o) => keyOf(o.card))));
    } catch (e) {
      return log(`gate_unavailable · проверка отозванных при старте: ${e}`);
    }
    if (!gone.length) return;
    for (const o of open) {
      const id = keyOf(o.card);
      if (!gone.includes(id)) continue;
      log(`revoked ${id} · закрыт при старте объекта`);
      o.ws.close(1008, "revoked");
    }
    await this.broadcast();
  }

  /** Ошибка в коде relay: строка в журнале и чистый перезапуск объекта. */
  private crash(e: unknown, where: string): never {
    log(`abort ${e instanceof Error ? (e.stack ?? e.message) : String(e)} · ${where}`);
    this.ctx.abort(String(e));
    throw e;
  }
}

/**
 * Ответ вызова по привязке: копия значения, а сам результат освобождён сразу.
 * Неосвобождённый результат держит сессию вызова — объект флота не засыпает.
 */
async function call<T>(p: T | Promise<T>): Promise<T> {
  const r = await p;
  if (!r || typeof r !== "object") return r;
  const v = structuredClone(r);
  (r as { [Symbol.dispose]?: () => void })[Symbol.dispose]?.();
  return v;
}

/** id кадра, который не прошёл разбор, — чтобы ответить bad_frame. */
function idOf(text: string): string | undefined {
  try {
    const x = JSON.parse(text);
    return isObj(x) && typeof x.id === "string" ? x.id : undefined;
  } catch {
    return undefined;
  }
}
