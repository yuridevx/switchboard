// Объект машины: соединения её Host, keeper и гостей. Всё состояние — карточки сокетов (attachment): они живут дольше сна объекта. На диск не пишет.
import { DurableObject } from "cloudflare:workers";
import type { GateApi, Verified } from "@switchboard/gate";
import { BAD_FRAME, CALL_MS, fail, hostOf, kindOf, machineOf, parseFrame, reaches, within, type Frame } from "@switchboard/protocol";
import type { Roster, RosterMachine, SessionRecord } from "../contract.ts";

export type Env = {
  FLEET: DurableObjectNamespace<Fleet>;
  GATE: GateApi;
  LEDGER: { frame(f: Frame): Promise<unknown> };
  PROTO: number[];
  CF_VERSION?: { id: string };
  /** стенд: предел вызова короче боевого */
  CALL_MS?: number;
};

export const callMs = (env: Env) => env.CALL_MS ?? CALL_MS;

/** Без addr — hello не было или соединение уже снято, а платформа ещё показывает сокет. row и sessions — только у Host этой машины. */
type Card = { ver: string; checking?: boolean; addr?: string; kid?: string; row?: RosterMachine; sessions?: SessionRecord[] };
type Seated = Card & { addr: string };

const ROLES: Record<string, string> = { part: "keeper", machine: "guest", device: "client" };
const cardOf = (ws: WebSocket) => ws.deserializeAttachment() as Card;
const hostAddress = (address: string) => `@${machineOf(address)}`;
const isSession = (a: unknown): a is string => kindOf(a) === "session";

/** Дошёл ли адрес до соединения. Сессия — Host её машины; свой Host сверяет её с карточкой, гость знает свои сессии сам. */
const reached = (c: Seated, to: string) => reaches(to, c.addr) || (isSession(to) && hostAddress(to) === c.addr && (c.sessions?.some((s) => s.callsign === to) ?? true));

/** Адреса кадра или причина, почему он не по форме. */
function addressesOf(f: Frame): string[] | string {
  if (Array.isArray(f.to)) {
    if (f.id !== undefined || !f.to.length) return "to списком — только непустой и у кадра без id";
    return f.to.every(kindOf) ? f.to : `не адрес: ${JSON.stringify(f.to)}`;
  }
  if (f.to !== undefined) return kindOf(f.to) ? [f.to] : `не адрес: ${JSON.stringify(f.to)}`;
  const machine = hostOf(f);
  if (machine === undefined) return "нет адреса";
  return machine === null ? `не адрес: ${f.callsign}` : [`@${machine}`];
}

/** id кадра, который не прошёл конверт: отказ дойдёт до спросившего. */
function idOf(text: string): string | undefined {
  try {
    const { id } = JSON.parse(text);
    return typeof id === "string" ? id : undefined;
  } catch {
    return undefined;
  }
}

export class Fleet extends DurableObject<Env> {
  private ver = this.env.CF_VERSION?.id ?? "";
  private machine = (this.ctx.id.name ?? "").slice("m/".length);

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    // выпуск relay спящие сокеты не рвёт, а кадры прежнего кода теряются: такие соединения закрываются, клиенты входят заново
    const stale = ctx.getWebSockets().filter((ws) => (cardOf(ws) as Card | null)?.ver !== this.ver);
    for (const ws of stale) this.drop(ws, 1012, "relay_updated");
    if (stale.length) console.log(`relay_updated ${stale.length} соединений прежнего кода`);
  }

  fetch(): Response {
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ ver: this.ver });
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws: WebSocket, data: string | ArrayBuffer) {
    const text = String(data);
    const f = parseFrame(text);
    return this.guarded(f?.type, async () => {
      if (ws.readyState !== WebSocket.OPEN) return;
      const card = cardOf(ws);
      if (!card.addr) await this.entering(ws, card, f);
      else if (f) this.onFrame(ws, card as Seated, f);
      else this.refuse(ws, idOf(text), BAD_FRAME, `${card.addr} · не кадр`);
    });
  }

  webSocketClose(ws: WebSocket, code: number, reason: string) {
    return this.guarded("webSocketClose", () => this.gone(ws, `${code} ${reason}`));
  }

  webSocketError(ws: WebSocket, e: unknown) {
    return this.guarded("webSocketError", () => this.gone(ws, String(e)));
  }

  /** Привязка Relay.deliver: кадр Worker'а соединениям этой машины. */
  deliver(f: Frame): number {
    const n = this.send(f, [f.to as string]);
    console.log(`${n ? "deliver" : "offline"} ${f.from} → ${f.to} ${f.type}`);
    return n;
  }

  /** Отзыв: соединения номера закрыты; сколько закрыто. */
  revoke(kid: string): number {
    const hit = this.seated().filter(([, c]) => c.kid === kid);
    for (const [ws] of hit) this.drop(ws, 1008, "revoked");
    if (hit.length) {
      console.log(`revoked ${kid} · ${hit.length}`);
      this.spread();
    }
    return hit.length;
  }

  /** Ошибка в коде relay: причина в журнал и чистый перезапуск объекта, соединения входят заново. */
  private async guarded(where: unknown, work: () => void | Promise<void>) {
    try {
      await work();
    } catch (e) {
      console.log(`abort ${where} · ${(e as Error).stack ?? e}`);
      this.ctx.abort(String(e));
    }
  }

  /** Вызов привязки с пределом. Результат RPC держит сессию, а она — объект: не освободить, и объект не уснёт. */
  private async call<T>(who: string, work: () => Promise<T>): Promise<T> {
    const ms = callMs(this.env);
    const r = await within(work(), `${who} не ответил за ${ms / 1000} с`, ms);
    (r as Partial<Disposable> | undefined)?.[Symbol.dispose]?.();
    return r;
  }

  private seated() {
    return this.ctx.getWebSockets().flatMap((ws) => {
      const c = cardOf(ws);
      return c.addr && ws.readyState === WebSocket.OPEN ? [[ws, c as Seated] as const] : [];
    });
  }

  private roster(): Roster {
    const cards = this.seated().map(([, c]) => c);
    const guests = cards.filter((c) => !c.row && kindOf(c.addr) !== "part").map((c) => c.addr);
    return { type: "roster", machines: cards.flatMap((c) => c.row ?? []), sessions: cards.flatMap((c) => c.sessions ?? []), clients: [...new Set(guests)] };
  }

  /** roster всем, кроме keeper: он получает его только при входе. */
  private spread() {
    const text = JSON.stringify(this.roster());
    for (const [ws, c] of this.seated()) if (kindOf(c.addr) !== "part") ws.send(text);
  }

  /** Кадр одной копией каждому соединению, до которого дошёл адрес. */
  private send(f: Frame, to: string[]): number {
    const text = JSON.stringify(f);
    const receivers = this.seated().filter(([, c]) => to.some((a) => reached(c, a)));
    for (const [ws] of receivers) ws.send(text);
    return receivers.length;
  }

  private refuse(ws: WebSocket, id: string | undefined, word: string, why: string) {
    console.log(`${word} ${why}`);
    if (id) ws.send(JSON.stringify(fail(id, word)));
  }

  private onFrame(ws: WebSocket, card: Seated, f: Frame) {
    const no = (word: string, why: string) => this.refuse(ws, f.id, word, `${card.addr} ${f.type} · ${why}`);
    if (f.type === "session.state") return this.onSessionState(ws, card, f, no);
    if (f.type === "hello" || f.type === "roster") return no(BAD_FRAME, "имя relay");
    const from = f.from ?? card.addr;
    if (from !== card.addr && !(isSession(from) && hostAddress(from) === card.addr)) return no("bad_from", `from ${from}`);
    const to = addressesOf(f);
    if (typeof to === "string") return no(BAD_FRAME, to);
    if (!this.send({ ...f, from }, to)) this.refuse(ws, f.id, "offline", `${from} ${f.type} → ${to}`);
  }

  private onSessionState(ws: WebSocket, card: Seated, f: Frame, no: (word: string, why: string) => void) {
    const { type: _type, id: _id, v: _v, to: _to, from: _from, ...record } = f;
    const { callsign, state } = record;
    if (!card.sessions) return no("bad_from", "только от Host своей машины");
    if (!isSession(callsign) || machineOf(callsign) !== this.machine) return no("bad_from", `callsign ${callsign}`);
    const was = card.sessions;
    const other = (s: SessionRecord) => s.callsign !== callsign;
    const fresh = record as SessionRecord;
    const sessions = state === null ? was.filter(other) : was.every(other) ? [...was, fresh] : was.map((s) => (other(s) ? s : fresh));
    const tooBig = this.save(ws, { ...card, sessions });
    if (tooBig) return no(BAD_FRAME, tooBig);
    this.spread();
  }

  /** Записать карточку; предел знает платформа. Не влезла — причина. */
  private save(ws: WebSocket, card: Card): string | undefined {
    try {
      ws.serializeAttachment(card);
    } catch {
      return `карточка ${new TextEncoder().encode(JSON.stringify(card)).length} байт · предел 16384`;
    }
  }

  /** Карточка входящего или отказ: слово и причина. */
  private seat(who: Verified, f: Frame): Seated | [string, string] {
    if (!this.env.PROTO.includes(f.proto as number)) return ["contract_mismatch", `proto ${JSON.stringify(f.proto)}`];
    const mine = who.addr === `@${this.machine}`;
    if (f.part !== undefined && (f.part !== "keeper" || !mine)) return [BAD_FRAME, `part ${JSON.stringify(f.part)} с пропуском ${who.addr}`];
    const base = { ver: this.ver, kid: who.kid };
    if (f.part) return { ...base, addr: `.keeper@${this.machine}` };
    if (!mine) return { ...base, addr: who.addr };
    const sessions = f.sessions ?? [];
    if (!Array.isArray(sessions) || !sessions.every((s) => isSession(s?.callsign) && machineOf(s.callsign) === this.machine)) return ["bad_from", "в hello callsign не этой машины"];
    const row = { machine: this.machine, since: Date.now(), proto: f.proto, sdk: f.sdk, contract: f.contract } as RosterMachine;
    return { ...base, addr: who.addr, sessions, row };
  }

  private async entering(ws: WebSocket, card: Card, f: Frame | null) {
    if (f?.type !== "hello" || card.checking) {
      console.log(`bad_frame до hello · ${f?.type ?? "не кадр"}`);
      return ws.close(1008, BAD_FRAME);
    }
    ws.serializeAttachment({ ...card, checking: true });
    const key = String(f.key);
    // в журнал — пропуск без секрета
    const pass = key.split(".").slice(0, -1).join(".");
    const shut = (word: string, why: string) => {
      console.log(`${word} ${pass} · ${why}`);
      ws.close(1008, word);
    };
    const who = await this.call("gate", () => this.env.GATE.verify(key)).catch((e) => ({ error: "gate_unavailable", why: String(e) }));
    if (ws.readyState !== WebSocket.OPEN) return;
    if ("error" in who) return shut(who.error, "why" in who ? who.why : "gate");
    const seat = this.seat(who, f);
    if (Array.isArray(seat)) return shut(...seat);
    const tooBig = this.save(ws, seat);
    if (tooBig) return shut(BAD_FRAME, tooBig);

    // у пропуска машины соединение одно; устройств человека может быть несколько
    const rivals = kindOf(seat.addr) === "device" ? [] : this.seated().filter(([other, c]) => other !== ws && c.addr === seat.addr);
    for (const [other, c] of rivals) {
      console.log(`replaced ${c.addr} ${c.kid}`);
      other.serializeAttachment({ ver: this.ver });
      other.close(1000, "replaced");
    }
    console.log(`hello ${pass} · ${seat.row ? "host" : ROLES[kindOf(seat.addr)!]} · ${seat.sessions?.length ?? 0} сессий · proto ${f.proto}`);
    if (seat.row && !rivals.length) this.ledger("machine.back");
    if (kindOf(seat.addr) === "part") ws.send(JSON.stringify(this.roster()));
    else this.spread();
  }

  /** Сокет ушёл сам: снять с места, рассказать остальным. */
  private gone(ws: WebSocket, why: string) {
    const c = cardOf(ws);
    if (!c.addr) return;
    console.log(`close ${c.addr} ${c.kid} · ${why}`);
    this.unseat(ws, c);
    if (kindOf(c.addr) !== "part") this.spread();
  }

  /** Закрыть сокет сервером: он снят сразу, закрытие могло и не дойти. */
  private drop(ws: WebSocket, code: number, word: string) {
    this.unseat(ws, cardOf(ws));
    ws.close(code, word);
  }

  private unseat(ws: WebSocket, c: Card | null) {
    ws.serializeAttachment({ ver: this.ver });
    if (c?.sessions) this.ledger("machine.left");
  }

  /** Вход и уход машины. Журнал никого не задерживает: не ответил — строка здесь. */
  private ledger(ev: string) {
    const { machine } = this;
    console.log(`${ev} ${machine}`);
    const add = this.call("журнал", () => this.env.LEDGER.frame({ type: "ledger.add", v: 1, to: ".ledger", ev, machine, from: ".relay" }));
    this.ctx.waitUntil(add.catch((e) => console.log(`offline .ledger ${ev} ${machine} · ${e}`)));
  }
}
