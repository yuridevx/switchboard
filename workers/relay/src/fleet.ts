// Объект relay машины m/<машина>: соединения и их карточки, hello через gate, roster, доставка по адресу, from.
// Держит её Host и keeper и гостей — Host других машин, устройства, программы. Доставляет только своей машине и гостям.
// На диск не пишет: всё — в карточках живых соединений.
import { DurableObject } from "cloudflare:workers";
import { fail, hostOf, kindOf, machineOf, parseFrame, reaches } from "@switchboard/protocol";
import type { Frame } from "@switchboard/protocol";
import type { GateApi, VerifyResult } from "@switchboard/gate";
import type { Participant, RelayWord, Roster, SessionRecord } from "../contract.ts";

export type Env = {
  FLEET: DurableObjectNamespace<Fleet>;
  GATE: GateApi;
  /** журнал: вход и уход Host своей машины пишет relay */
  LEDGER: Participant;
  /** версии контракта relay, которые принимает hello */
  PROTO: number[];
  /** версия Worker'а от платформы (version_metadata): карточка помнит, каким кодом принято соединение */
  CF_VERSION?: { id: string };
  /** предел вызова журнала, мс; только стенд — в бою 120 000, как предел запроса link */
  CALL_MS?: number;
};

/** Имя объекта машины. */
export const machineObject = (machine: string) => `m/${machine}`;
/** Предел карточки соединения у Cloudflare. */
export const CARD_LIMIT = 16_384;
/** Имена relay: из них по сети разбирается только session.state; hello — первым кадром. */
const OWN = new Set(["hello", "roster", "session.state", "frame"]);

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
/** Host другой машины в гостях: доставка ему — по адресам его машины; в roster — среди гостей @машина */
type GuestCard = { role: "guest"; name: string; kid: string; since: number; proto: number };
/** устройство или программа: адрес — из ответа gate */
type ClientCard = { role: "client"; name: string; kid: string; addr: string; since: number; proto: number };
/** часть машины (keeper): входит ключом своей машины с part в hello; в roster не входит, адрес .keeper@машина */
type KeeperCard = { role: "keeper"; name: string; kid: string; since: number; proto: number };
/** ver — версия кода relay, принявшего hello */
type Card = (HostCard | GuestCard | ClientCard | KeeperCard) & { ver?: string };
type Sender = { ws: WebSocket; card: Card };

const log = (line: string) => console.log(line);
const enc = new TextEncoder();
const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
/** Карточка принятого hello; до hello у сокета только версия кода, принявшего его. */
const cardOf = (ws: WebSocket) => {
  const a = ws.deserializeAttachment() as (Card | { ver: string }) | null;
  return a && "role" in a ? a : null;
};
const verOf = (ws: WebSocket) => (ws.deserializeAttachment() as { ver?: string } | null)?.ver;
/** role.name.kid пропуска — без секрета: секрет в журнал не попадает. */
const keyId = (key: string) => key.split(".").slice(0, 3).join(".").slice(0, 80);
/** callsign сессии этой машины: site@laptop; голый @laptop — не сессия. */
const ownCallsign = (cs: unknown, machine: string) => typeof cs === "string" && cs.indexOf("@") > 0 && machineOf(cs) === machine;

export class Fleet extends DurableObject<Env> {
  private ready: Promise<void>;
  /** соединения, чей hello сейчас проверяет gate */
  private verifying = new Set<WebSocket>();
  /** машина объекта */
  private machine: string;
  /** свои Host на связи — по ним relay пишет в журнал вход и уход машины */
  private up = new Set<string>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.machine = (ctx.id.name ?? "").slice("m/".length);
    // ping → pong отвечает Cloudflare, объект не просыпается
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    this.up = this.present();
    this.ready = this.recheck();
  }

  async fetch(): Promise<Response> {
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    // версия кода, принявшего сокет: hello, потерянный при смене кода, не держит соединение без карточки
    server.serializeAttachment({ ver: this.ver() });
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, msg: string | ArrayBuffer): Promise<void> {
    let type = "?";
    try {
      await this.ready;
      // старт объекта закрыл отправителя (прежний код relay): кадр потерян, как и прочие кадры в пути
      if (ws.readyState !== 1) return;
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
      if (card.role !== "keeper") await this.changed(ws);
    } catch (e) {
      this.crash(e, "webSocketClose");
    }
  }

  async webSocketError(ws: WebSocket, err: unknown): Promise<void> {
    const card = cardOf(ws);
    log(`error ${card ? `${card.role}.${card.name}` : "до hello"} · ${err}`);
  }

  /** Отзыв пропуска: закрыть соединения с этим номером словом revoked. Ответ — сколько закрыто. */
  async close(kid: string): Promise<number> {
    await this.ready;
    const gone = this.live().filter((ws) => cardOf(ws)!.kid === kid);
    for (const ws of gone) {
      const c = cardOf(ws)!;
      log(`revoked ${c.role}.${c.name}.${kid} · закрыт отзывом`);
      ws.close(1008, "revoked");
    }
    if (gone.length) await this.changed();
    return gone.length;
  }

  /** Кадр Worker'а по привязке (вход relay deliver): доставка своей машине; from ставит вызывающий. Ответ — сколько получателей. */
  async deliver(f: Frame): Promise<number> {
    await this.ready;
    const to = typeof f.to === "string" ? f.to : "";
    const n = kindOf(to) ? await this.send(to, f, String(f.from)) : 0;
    log(`${n ? "deliver" : "offline"} ${String(f.from)} → ${to} · ${f.type}`);
    return n;
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
    const mine = r.role === "host" && r.name === this.machine;
    // часть машины входит пропуском машины в relay своей машины; в рацию из частей выходит только keeper
    if (f.part !== undefined && !(mine && f.part === "keeper")) {
      log(`bad_frame ${id} · part ${JSON.stringify(f.part)} — в relay своей машины входит только keeper пропуском машины`);
      return ws.close(1008, "bad_frame");
    }
    if (f.part === "keeper") {
      card = { role: "keeper", name: r.name, kid: r.kid, since, proto: f.proto };
    } else if (mine) {
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
    } else if (r.role === "host") {
      card = { role: "guest", name: r.name, kid: r.kid, since, proto: f.proto };
    } else {
      card = { role: "client", name: r.name, kid: r.kid, addr: r.addr, since, proto: f.proto };
    }
    const size = enc.encode(JSON.stringify(card)).length;
    if (size > CARD_LIMIT) {
      log(`bad_frame ${id} · карточка ${size} байт · предел ${CARD_LIMIT}`);
      return ws.close(1008, "bad_frame");
    }
    // машина одна: новый hello той же машины в той же роли вытесняет прежний
    if (card.role !== "client") {
      for (const s of this.live()) {
        const c = cardOf(s)!;
        if (s !== ws && c.role === card.role && c.name === card.name) {
          log(`replaced ${c.role}.${c.name}.${c.kid}`);
          s.close(1000, "replaced");
        }
      }
    }
    ws.serializeAttachment({ ...card, ver: this.ver() });
    log(`hello ${id} · ${card.role}${card.role === "host" ? ` · ${card.sessions.length} сессий` : ""} · proto ${card.proto}`);
    // keeper в roster не входит: roster — только ему, как знак, что hello принят; флот не меняется
    if (card.role === "keeper") ws.send(JSON.stringify(this.roster()));
    else await this.changed();
  }

  // ---------- кадр после hello: один порядок для соединений и участников ----------

  private async route(s: Sender, f: Frame): Promise<RelayWord | undefined> {
    const refuse = (word: RelayWord, why: string): RelayWord => {
      log(`${word} ${this.who(s)} · ${f.type}${why ? " · " + why : ""}`);
      return word;
    };

    // from ставит relay по пропуску: keeper — .keeper@машина, клиент — адрес от gate;
    // Host, свой или гость, — сама машина или сессия этой машины
    let from: string;
    if (s.card.role !== "host" && s.card.role !== "guest") {
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
      for (const a of list) n += await this.send(a, out, this.who(s));
      return n ? undefined : refuse("offline", `→ ${list.join(",")}`);
    }
    const m = hostOf(f);
    if (m === undefined) return refuse("bad_frame", "нет адреса");
    if (!m) return refuse("bad_frame", `callsign ${String(f.callsign)}`);
    const host = this.machineConn(m);
    if (!host) return refuse("offline", `→ @${m}`);
    host.send(JSON.stringify(out));
    return undefined;
  }

  private async sessionState(s: Sender, f: Frame, refuse: (w: RelayWord, why: string) => RelayWord): Promise<RelayWord | undefined> {
    if (s.card.role !== "host") return refuse("bad_from", "session.state не от своего Host");
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

  /** Доставить по одному адресу по его виду: своей машине и своим гостям. Ответ — сколько получателей. */
  private async send(a: string, out: Frame, sender: string): Promise<number> {
    const text = JSON.stringify(out);
    switch (kindOf(a)) {
      case "machine":
      case "session": {
        const ws = this.machineConn(machineOf(a)!);
        if (!ws) return 0;
        // callsign своего Host — только если он есть в карточке; гостю — всё по адресам его машины
        const c = cardOf(ws)!;
        if (c.role === "host" && !a.startsWith("@") && !c.sessions.some((x) => x.callsign === a)) return 0;
        ws.send(text);
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
          if (c.role === "client" && reaches(a, c.addr)) {
            ws.send(text);
            n++;
          }
        }
        return n;
      }
      default:
        // служба (Worker) — прямым запросом по её адресу, не через relay
        return 0;
    }
  }

  /** Адрес отправителя — по пропуску или привязке. */
  private who(s: Sender): string {
    switch (s.card.role) {
      case "host":
      case "guest":
        return `@${s.card.name}`;
      case "keeper":
        return `.keeper@${s.card.name}`;
      default:
        return s.card.addr;
    }
  }

  // ---------- roster ----------

  /** Живые соединения с принятым hello. */
  private live(except?: WebSocket): WebSocket[] {
    return this.ctx.getWebSockets().filter((s) => s !== except && s.readyState === 1 && cardOf(s));
  }

  /** Соединение машины: свой Host или Host этой машины в гостях. */
  private machineConn(machine: string): WebSocket | undefined {
    const all = this.live();
    const by = (role: string) => all.find((s) => {
      const c = cardOf(s)!;
      return c.role === role && c.name === machine;
    });
    return by("host") ?? by("guest");
  }

  /** roster объекта: своя машина и её сессии; гости — устройства, программы и Host других машин (@машина). */
  roster(except?: WebSocket): Roster {
    const r: Roster = { type: "roster", machines: [], sessions: [], clients: [] };
    for (const s of this.live(except)) {
      const c = cardOf(s)!;
      if (c.role === "host") {
        r.machines.push({ machine: c.name, since: c.since, proto: c.proto, sdk: c.sdk, contract: c.contract });
        r.sessions.push(...c.sessions);
        continue;
      }
      const addr = c.role === "client" ? c.addr : c.role === "guest" ? `@${c.name}` : null;
      if (addr && !r.clients.includes(addr)) r.clients.push(addr);
    }
    return r;
  }

  /** roster — всем соединениям, кроме keeper: ему — только первый, при входе. */
  private async broadcast(except?: WebSocket): Promise<void> {
    const text = JSON.stringify(this.roster(except));
    for (const s of this.live(except)) if (cardOf(s)!.role !== "keeper") s.send(text);
  }

  /** Состав соединений изменился: вход и уход своих Host — в журнал, roster — всем. */
  private async changed(except?: WebSocket): Promise<void> {
    const now = this.present(except);
    const back = [...now].filter((m) => !this.up.has(m));
    const left = [...this.up].filter((m) => !now.has(m));
    this.up = now;
    await Promise.all([...back.map((m) => this.journal("machine.back", m)), ...left.map((m) => this.journal("machine.left", m))]);
    await this.broadcast(except);
  }

  /** Свои Host на связи. */
  private present(except?: WebSocket): Set<string> {
    return new Set(this.live(except).map((s) => cardOf(s)!).filter((c) => c.role === "host").map((c) => c.name));
  }

  /** Запись журнала о своей машине: текст пишет журнал по своим прежним записям. Журнал не ответил — строка здесь. */
  private async journal(ev: "machine.back" | "machine.left", machine: string): Promise<void> {
    log(`${ev} ${machine}`);
    try {
      await this.within(call(this.env.LEDGER.frame({ type: "ledger.add", v: 1, to: ".ledger", ev, machine, from: ".relay" })), `журнал не ответил за ${this.callMs() / 1000} с`);
    } catch (e) {
      log(`offline relay → .ledger · ${ev} ${machine} · ${e}`);
    }
  }

  // ---------- пределы ----------

  /** Предел вызова журнала — как предел запроса link: 120 с (стенд ставит меньше). */
  private callMs(): number {
    return this.env.CALL_MS ?? 120_000;
  }

  /** Обещание или исключение со словами why за предел вызова. */
  private within<T>(p: Promise<T>, why: string): Promise<T> {
    let t = 0;
    const late = new Promise<never>((_ok, no) => (t = setTimeout(() => no(new Error(why)), this.callMs())));
    return Promise.race([p, late]).finally(() => clearTimeout(t));
  }

  /** Версия кода relay; без привязки — пустая. */
  private ver(): string {
    return this.env.CF_VERSION?.id ?? "";
  }

  /**
   * Старт объекта: соединения, принятые прежним кодом relay, — закрыть словом relay_updated: выпуск relay спящие
   * веб-сокеты не рвёт, и кадры, бывшие в пути при смене кода, теряются молча; клиенты переподключаются по ветке
   * устава «соединение оборвалось», keeper спрашивает план заново, ждущие запросы получают disconnected.
   */
  private async recheck(): Promise<void> {
    const stale = this.ctx.getWebSockets().filter((ws) => ws.readyState === 1 && verOf(ws) !== this.ver());
    for (const ws of stale) ws.close(1012, "relay_updated");
    if (!stale.length) return;
    log(`relay_updated · закрыто соединений прежнего кода relay: ${stale.length}`);
    await this.changed();
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
 * Неосвобождённый результат держит сессию вызова — объект не засыпает.
 */
export async function call<T>(p: T | Promise<T>): Promise<T> {
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
