// Объект машины: соединения её Host, keeper и гостей. Всё состояние — карточки сокетов (attachment): они живут дольше кода и сна объекта.
import { DurableObject } from "cloudflare:workers";
import type { GateApi, VerifyResult } from "@switchboard/gate";
import { BAD_FRAME, CALL_MS, fail, hostOf, kindOf, machineOf, parseFrame, reaches, within, type Frame } from "@switchboard/protocol";
import type { Roster, SessionRecord } from "../contract.ts";

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

/** Карточка сокета; addr — вошёл; sessions — Host этой машины. Роль выводится из адреса. */
type Card = { ver: string; machine: string; addr?: string; kid?: string; since?: number; proto?: number; sdk?: unknown; contract?: unknown; sessions?: SessionRecord[] };
type Seated = Card & { addr: string };

/** Предел платформы на attachment; значение — только для журнала. */
const CARD_BYTES = 16_384;
const cardOf = (ws: WebSocket) => ws.deserializeAttachment() as Card;
const hostAddress = (address: string) => `@${machineOf(address)}`;
const isSession = (a: unknown) => kindOf(a) === "session";

/** Дошёл ли адрес до соединения: своим адресом, человек до устройства, сессия до Host её машины; свой Host — только по своим сессиям. */
const reached = (c: Seated, to: string) => reaches(to, c.addr) || (isSession(to) && hostAddress(to) === c.addr && (c.sessions?.some((s) => s.callsign === to) ?? true));

/** Свой ли from: свой адрес или сессия своей машины. */
const own = (c: Seated, from: unknown) => from === c.addr || (isSession(from) && hostAddress(from as string) === c.addr);

/** Адреса кадра или причина отказа. */
function addressesOf(f: Frame): string[] | string {
  if (Array.isArray(f.to)) {
    if (f.id !== undefined || !f.to.length) return "to списком — только непустой и у кадра без id";
    const bad = f.to.find((a) => !kindOf(a));
    return bad === undefined ? f.to : `не адрес: ${bad}`;
  }
  if (f.to !== undefined) return kindOf(f.to) ? [f.to] : `не адрес: ${f.to}`;
  const machine = hostOf(f);
  if (machine === undefined) return "нет адреса";
  return machine === null ? `не адрес: ${f.callsign}` : [`@${machine}`];
}

export class Fleet extends DurableObject<Env> {
  private ver = this.env.CF_VERSION?.id ?? "";
  /** сокеты, чей hello сейчас у gate */
  private checking = new Set<WebSocket>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    const stale = ctx.getWebSockets().filter((ws) => (cardOf(ws) as Card | null)?.ver !== this.ver);
    for (const ws of stale) this.drop(ws, 1012, "relay_updated");
    if (stale.length) console.log(`relay_updated ${stale.length} соединений прежнего кода`);
  }

  fetch(req: Request): Response {
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ ver: this.ver, machine: new URL(req.url).pathname.slice(3) });
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
    if (ws.readyState !== WebSocket.OPEN) return;
    const text = String(data);
    const f = parseFrame(text);
    try {
      const card = cardOf(ws);
      if (!card.addr) await this.entering(ws, card, f);
      else if (f) this.onFrame(ws, card as Seated, f);
      else this.refuse(ws, idOf(text), BAD_FRAME, `${card.addr} · не кадр`);
    } catch (e) {
      console.log(`abort ${f?.type} · ${(e as Error).stack ?? e}`);
      this.ctx.abort(String(e));
    }
  }

  webSocketClose(ws: WebSocket, code: number, reason: string): void {
    this.gone(ws, `${code} ${reason}`);
  }

  webSocketError(ws: WebSocket, e: unknown): void {
    this.gone(ws, String(e));
  }

  /** Привязка Relay.deliver: кадр Worker'а соединениям этой машины. */
  deliver(f: Frame): number {
    const n = this.send(f, [f.to as string]);
    console.log(`${n ? "deliver" : "offline"} ${f.from} → ${f.to} ${f.type} · ${n}`);
    return n;
  }

  /** Отзыв: соединения номера закрыты; сколько закрыто. */
  revoke(kid: string): number {
    const mine = this.seated().filter(([, c]) => c.kid === kid);
    for (const [ws] of mine) this.drop(ws, 1008, "revoked");
    if (mine.length) {
      console.log(`revoked ${kid} · ${mine.length}`);
      this.spread();
    }
    return mine.length;
  }

  private seated() {
    return this.ctx.getWebSockets().flatMap((ws) => {
      const c = cardOf(ws);
      return c.addr && ws.readyState === WebSocket.OPEN ? [[ws, c as Seated] as const] : [];
    });
  }

  private roster(): Roster {
    const cards = this.seated().map(([, c]) => c);
    const host = cards.find((c) => c.sessions);
    const guests = cards.filter((c) => c !== host && kindOf(c.addr) !== "part").map((c) => c.addr);
    const machines = host ? [{ machine: host.machine, since: host.since, proto: host.proto, sdk: host.sdk, contract: host.contract }] : [];
    return { type: "roster", machines, sessions: host?.sessions ?? [], clients: [...new Set(guests)] } as Roster;
  }

  /** roster всем, кроме keeper: его получает только при входе. */
  private spread(): void {
    const text = JSON.stringify(this.roster());
    for (const [ws, c] of this.seated()) if (kindOf(c.addr) !== "part") ws.send(text);
  }

  /** Кадр одной копией каждому соединению, до которого дошёл адрес. */
  private send(f: Frame, to: string[]): number {
    const text = JSON.stringify(f);
    const reachedBy = this.seated().filter(([, c]) => to.some((a) => reached(c, a)));
    for (const [ws] of reachedBy) ws.send(text);
    return reachedBy.length;
  }

  private refuse(ws: WebSocket, id: string | undefined, word: string, why: string): void {
    console.log(`${word} ${why}`);
    if (id) ws.send(JSON.stringify(fail(id, word)));
  }

  private onFrame(ws: WebSocket, card: Seated, f: Frame): void {
    const no = (word: string, why: string) => this.refuse(ws, f.id, word, `${card.addr} ${f.type} · ${why}`);
    if (f.type === "session.state") return this.onSessionState(ws, card, f, no);
    if (f.type === "hello" || f.type === "roster") return no(BAD_FRAME, "имя relay");
    const from = f.from ?? card.addr;
    if (!own(card, from)) return no("bad_from", `from ${from}`);
    const to = addressesOf(f);
    if (typeof to === "string") return no(BAD_FRAME, to);
    if (!this.send({ ...f, from }, to)) this.refuse(ws, f.id, "offline", `${from} ${f.type} → ${to}`);
  }

  private onSessionState(ws: WebSocket, card: Seated, f: Frame, no: (word: string, why: string) => void): void {
    const { type: _t, id: _i, v: _v, to: _to, from: _f, ...record } = f;
    const { callsign } = f;
    if (!card.sessions) return no("bad_from", "только от Host своей машины");
    if (!isSession(callsign) || machineOf(callsign as string) !== card.machine) return no("bad_from", `callsign ${callsign}`);
    const was = card.sessions;
    const sessions =
      f.state === null
        ? was.filter((s) => s.callsign !== callsign)
        : was.some((s) => s.callsign === callsign)
          ? was.map((s) => (s.callsign === callsign ? (record as SessionRecord) : s))
          : [...was, record as SessionRecord];
    const why = this.save(ws, { ...card, sessions });
    if (why) return no(BAD_FRAME, why);
    this.spread();
  }

  /** Записать карточку; не влезла — причина. */
  private save(ws: WebSocket, card: Card): string | undefined {
    try {
      ws.serializeAttachment(card);
    } catch {
      return `карточка ${new TextEncoder().encode(JSON.stringify(card)).length} байт · предел ${CARD_BYTES}`;
    }
  }

  private async entering(ws: WebSocket, card: Card, f: Frame | null): Promise<void> {
    if (f?.type !== "hello" || this.checking.has(ws)) {
      console.log(`bad_frame до hello · ${f?.type ?? "не кадр"}`);
      return ws.close(1008, BAD_FRAME);
    }
    // номер без секрета: пропуск role.name.kid.секрет
    const label = String(f.key).split(".").slice(0, -1).join(".");
    const limit = callMs(this.env);
    this.checking.add(ws);
    let who: VerifyResult;
    try {
      who = await within(this.env.GATE.verify(String(f.key)), `gate не ответил за ${limit / 1000} с`, limit);
      // результат RPC держит сессию вызова: пока он не закрыт, объект не засыпает
      (who as Partial<Disposable>)[Symbol.dispose]?.();
    } catch (e) {
      console.log(`gate ${label} gate_unavailable · ${e}`);
      return ws.close(1008, "gate_unavailable");
    } finally {
      this.checking.delete(ws);
    }
    if (ws.readyState !== WebSocket.OPEN) return;
    const shut = (word: string, why: string) => {
      console.log(`${word} ${label} · ${why}`);
      ws.close(1008, word);
    };
    if ("error" in who) return shut(who.error, "gate");
    if (!this.env.PROTO.includes(f.proto as number)) return shut("contract_mismatch", `proto ${JSON.stringify(f.proto)}`);

    const mine = who.addr === `@${card.machine}`;
    if (f.part !== undefined && (f.part !== "keeper" || !mine)) return shut(BAD_FRAME, `part ${f.part} с пропуском ${who.addr}`);
    const keeper = f.part === "keeper";
    const seat: Seated = { ...card, addr: keeper ? `.keeper@${card.machine}` : who.addr, kid: who.kid, since: Date.now(), proto: f.proto as number };
    if (mine && !keeper) {
      const sessions = f.sessions ?? [];
      const good = Array.isArray(sessions) && sessions.every((s) => isSession(s?.callsign) && machineOf(s.callsign) === card.machine);
      if (!good) return shut("bad_from", `callsign не этой машины: ${JSON.stringify(sessions).slice(0, 200)}`);
      Object.assign(seat, { sdk: f.sdk, contract: f.contract, sessions });
    }
    const why = this.save(ws, seat);
    if (why) return shut(BAD_FRAME, why);

    // второе соединение той же машины или части вытесняет первое; у устройств их сколько угодно
    const rivals = kindOf(seat.addr) === "device" ? [] : this.seated().filter(([other, c]) => other !== ws && c.addr === seat.addr);
    for (const [other, c] of rivals) {
      console.log(`replaced ${c.kid}`);
      other.serializeAttachment({ ver: this.ver, machine: c.machine });
      other.close(1000, "replaced");
    }
    const role = keeper ? "keeper" : mine ? "host" : who.role === "host" ? "guest" : "client";
    console.log(`hello ${who.kid} ${seat.addr} ${role} · ${seat.sessions?.length ?? 0} сессий · proto ${seat.proto}`);
    if (seat.sessions && !rivals.length) this.ledger("machine.back", seat.machine);
    if (keeper) ws.send(JSON.stringify(this.roster()));
    else this.spread();
  }

  /** Сокет ушёл сам: снять с места, рассказать остальным. */
  private gone(ws: WebSocket, why: string): void {
    const c = cardOf(ws);
    if (!c.addr) return;
    console.log(`close ${c.addr} ${why}`);
    this.unseat(ws, c);
    if (kindOf(c.addr) !== "part") this.spread();
  }

  /** Закрыть сокет сервером: снимается сразу, не дожидаясь ответа на close. */
  private drop(ws: WebSocket, code: number, word: string): void {
    this.unseat(ws, cardOf(ws));
    ws.close(code, word);
  }

  private unseat(ws: WebSocket, c: Card): void {
    ws.serializeAttachment({ ver: this.ver, machine: c.machine });
    if (c.sessions) this.ledger("machine.left", c.machine);
  }

  private ledger(ev: string, machine: string): void {
    console.log(`${ev} ${machine}`);
    const limit = callMs(this.env);
    const add = async () => this.env.LEDGER.frame({ type: "ledger.add", v: 1, to: ".ledger", ev, machine, from: ".relay" });
    this.ctx.waitUntil(within(add(), `журнал не ответил за ${limit / 1000} с`, limit).catch((e) => console.log(`offline .ledger ${ev} ${machine} · ${e}`)));
  }
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
