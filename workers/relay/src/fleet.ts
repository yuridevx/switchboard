// Объект машины: соединения с карточками в attachments платформы, roster из живых карточек, доставка по адресу. На диск не пишет.
import { DurableObject } from "cloudflare:workers";
import { CALL_MS, fail, hostOf, kindOf, machineOf, parseFrame, reaches, within, type Frame, type Reply } from "@switchboard/protocol";
import type { GateApi } from "@switchboard/gate";
import type { RosterMachine, SessionRecord } from "../contract.ts";

export type Env = {
  FLEET: DurableObjectNamespace<Fleet>;
  GATE: GateApi;
  LEDGER: { frame(f: Frame): Promise<unknown> };
  /** версии контракта, которые relay принимает в hello */
  PROTO: number[];
  /** версия кода: соединения прежнего кода закрываются при старте объекта */
  CF_VERSION?: { id: string };
  /** стенд: предел вызова короче боевого */
  CALL_MS?: number;
};

/** Карточка до входа. checking — hello у gate. Карточки нет (null) — соединение вытеснено или отозвано: для объекта его больше нет, даже если платформа ещё показывает сокет. */
type Bare = { ver: string; machine: string; checking?: boolean };
/** Карточка участника: row и sessions — только у своего Host объекта. */
type Member = Bare & { addr: string; kid: string; kind: "host" | "guest" | "keeper" | "client"; row?: RosterMachine; sessions?: SessionRecord[] };

const isSessionOf = (callsign: unknown, machine: string) => kindOf(callsign) === "session" && machineOf(callsign as string) === machine;

/** Дошёл ли адрес до соединения. Сессия — Host её машины; свой Host объекта сверяет её с карточкой, гость знает свои сессии сам. */
function arrives(to: string, c: Member): boolean {
  if (reaches(to, c.addr)) return true;
  return kindOf(to) === "session" && c.addr === `@${machineOf(to)}` && (c.sessions?.some((s) => s.callsign === to) ?? true);
}

/** Адреса кадра или причина, почему он не по форме. */
function addressesOf(f: Frame): string[] | string {
  if (f.type === "hello" || f.type === "roster") return "имя relay";
  if (Array.isArray(f.to)) {
    if (f.id) return "to списком у кадра с id";
    return f.to.every(kindOf) ? f.to : `to не адрес: ${JSON.stringify(f.to)}`;
  }
  if (f.to !== undefined) return kindOf(f.to) ? [f.to] : `to не адрес: ${JSON.stringify(f.to)}`;
  const machine = hostOf(f);
  if (machine === undefined) return "нет адреса";
  return machine === null ? `callsign ${f.callsign}` : [`@${machine}`];
}

/** Записать карточку; не влезла в предел платформы — причина. */
function stamp(ws: WebSocket, card: Bare | Member): string | null {
  try {
    ws.serializeAttachment(card);
    return null;
  } catch {
    return `карточка ${new TextEncoder().encode(JSON.stringify(card)).length} байт · предел 16384`;
  }
}

function idOf(text: string): string | undefined {
  try {
    const { id } = JSON.parse(text);
    return typeof id === "string" ? id : undefined;
  } catch {
    return undefined;
  }
}

const refuse = (word: string, why: string, c: Member, f: { type: string; id?: string }, ws: WebSocket) => {
  console.log(`${word} ${c.addr} · ${f.type} · ${why}`);
  if (f.id) ws.send(JSON.stringify(fail(f.id, word) satisfies Reply));
};

export class Fleet extends DurableObject<Env> {
  private readonly ver: string;
  private readonly callMs: number;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ver = env.CF_VERSION?.id ?? "dev";
    this.callMs = env.CALL_MS ?? CALL_MS;
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    this.closePreviousCode();
  }

  /** Выпуск relay спящие сокеты не рвёт, кадры прежнего кода теряются: при старте объекта такие соединения закрываются, клиенты входят заново. */
  private closePreviousCode() {
    const stale = this.ctx.getWebSockets().filter((ws) => !this.card(ws));
    for (const ws of stale) {
      const c = ws.deserializeAttachment() as Member | null;
      if (c?.kind === "host") void this.journal("machine.left", c.machine);
      ws.close(1012, "relay_updated");
    }
    if (stale.length) console.log(`relay_updated · закрыто соединений прежнего кода relay: ${stale.length}`);
  }

  private card(ws: WebSocket): Bare | Member | null {
    const c = ws.deserializeAttachment() as Bare | null;
    return c?.ver === this.ver ? c : null;
  }

  private members(): Array<[WebSocket, Member]> {
    return this.ctx.getWebSockets().flatMap((ws) => {
      const c = this.card(ws);
      return c && "addr" in c ? [[ws, c] as [WebSocket, Member]] : [];
    });
  }

  private rosterText(): string {
    const cards = this.members().map(([, c]) => c);
    return JSON.stringify({
      type: "roster",
      machines: cards.flatMap((c) => c.row ?? []),
      sessions: cards.flatMap((c) => c.sessions ?? []),
      clients: [...new Set(cards.filter((c) => c.kind === "guest" || c.kind === "client").map((c) => c.addr))],
    });
  }

  private broadcastRoster() {
    const text = this.rosterText();
    for (const [ws, c] of this.members()) if (c.kind !== "keeper") ws.send(text);
  }

  /** Вызов привязки с пределом. Результат RPC держит сессию, а она — объект: не освободить, и объект не уснёт. */
  private async call<T>(who: string, p: Promise<T>): Promise<T> {
    const r = await within(p, `${who} не ответил за ${this.callMs / 1000} с`, this.callMs);
    (r as Partial<Disposable> | undefined)?.[Symbol.dispose]?.();
    return r;
  }

  private async journal(ev: string, machine: string) {
    console.log(`${ev} ${machine}`);
    try {
      await this.call("журнал", this.env.LEDGER.frame({ type: "ledger.add", v: 1, to: ".ledger", ev, machine, from: ".relay" }));
    } catch (e) {
      console.log(`offline relay → .ledger · ${ev} ${machine} · ${e}`);
    }
  }

  /** Участник ушёл: флот узнаёт из roster, журнал — об уходе машины. */
  private afterLeaving(c: Member) {
    if (c.kind !== "keeper") this.broadcastRoster();
    if (c.kind === "host") void this.journal("machine.left", c.machine);
  }

  /** Закрыть участника самим объектом: карточка снимается сразу, закрытие могло и не дойти. */
  private expel(ws: WebSocket, c: Member, code: number, word: string) {
    ws.serializeAttachment(null);
    ws.close(code, word);
    console.log(`${word} ${c.addr} ${c.kid}`);
  }

  private sendTo(f: Frame, to: string[]): number {
    const text = JSON.stringify(f);
    const receivers = this.members().filter(([, c]) => to.some((a) => arrives(a, c)));
    for (const [ws] of receivers) ws.send(text);
    return receivers.length;
  }

  // ---------- вход платформы ----------

  fetch(req: Request): Response {
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ ver: this.ver, machine: new URL(req.url).pathname.slice("/m/".length) } satisfies Bare);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const text = String(message);
    try {
      const c = this.card(ws);
      if (c && "addr" in c) this.onFrame(ws, c, text);
      else if (c) await this.onHello(ws, c, text);
    } catch (e) {
      // ошибка в коде relay: причина в журнал и чистый перезапуск объекта, соединения входят заново
      console.log(`abort ${(e as Error).stack ?? e} · ${parseFrame(text)?.type ?? "не кадр"}`);
      this.ctx.abort(String(e));
    }
  }

  webSocketClose(ws: WebSocket, code: number, reason: string) {
    this.onGone(ws, `${code} ${reason}`);
  }

  webSocketError(ws: WebSocket, e: unknown) {
    this.onGone(ws, String(e));
  }

  private onGone(ws: WebSocket, why: string) {
    const c = this.card(ws);
    if (!c || !("addr" in c)) return;
    ws.serializeAttachment(null);
    console.log(`close ${c.addr} ${c.kid} · ${why}`);
    this.afterLeaving(c);
  }

  // ---------- привязки ----------

  deliver(f: Frame): number {
    const n = this.sendTo(f, [f.to as string]);
    console.log(`${n ? "deliver" : "offline"} ${f.from} → ${f.to} · ${f.type}`);
    return n;
  }

  /** Закрыть соединения отозванного номера; сколько закрыто. */
  revoke(kid: string): number {
    const hit = this.members().filter(([, c]) => c.kid === kid);
    for (const [ws, c] of hit) this.expel(ws, c, 1008, "revoked");
    for (const [, c] of hit) this.afterLeaving(c);
    return hit.length;
  }

  // ---------- hello ----------

  private async onHello(ws: WebSocket, c: Bare, text: string) {
    const f = parseFrame(text);
    if (f?.type !== "hello" || c.checking) {
      console.log(`bad_frame до hello · ${f?.type ?? "не кадр"}`);
      return ws.close(1008, "bad_frame");
    }
    ws.serializeAttachment({ ...c, checking: true } satisfies Bare);

    const key = String(f.key ?? "");
    // в журнал — пропуск без секрета
    const pass = key.split(".").slice(0, -1).join(".");
    const shut = (word: string, why = "") => {
      console.log(`${word} ${pass}${why && ` · ${why}`}`);
      ws.close(1008, word);
    };

    const who = await this.call("gate", this.env.GATE.verify(key)).catch((e) => ({ error: "gate_unavailable", why: String(e) }));
    if (ws.readyState !== WebSocket.READY_STATE_OPEN) return;
    if ("error" in who) return shut(who.error, "why" in who ? who.why : "");
    if (!this.env.PROTO.includes(f.proto as number)) return shut("contract_mismatch", `proto ${JSON.stringify(f.proto)} · relay ${JSON.stringify(this.env.PROTO)}`);

    const own = who.role === "host" && who.name === c.machine;
    if (f.part !== undefined && (f.part !== "keeper" || !own)) return shut("bad_frame", `part ${JSON.stringify(f.part)} — в relay своей машины входит только keeper пропуском машины`);
    const kind = f.part ? "keeper" : own ? "host" : who.role === "host" ? "guest" : "client";

    const card: Member = { ver: c.ver, machine: c.machine, kid: who.kid, kind, addr: kind === "keeper" ? `.keeper@${c.machine}` : who.addr };
    if (kind === "host") {
      const sessions = f.sessions ?? [];
      if (!Array.isArray(sessions) || !sessions.every((s) => isSessionOf(s?.callsign, c.machine))) return shut("bad_from", `в hello callsign не машины ${c.machine}`);
      card.sessions = sessions;
      card.row = { machine: c.machine, since: Date.now(), proto: f.proto as number, sdk: f.sdk as string | undefined, contract: f.contract as Record<string, number> | undefined };
    }
    const tooBig = stamp(ws, card);
    if (tooBig) return shut("bad_frame", tooBig);

    // у пропуска машины соединение одно; устройств человека может быть несколько
    const previous = kind === "client" ? [] : this.members().filter(([o, m]) => o !== ws && m.addr === card.addr);
    for (const [o, m] of previous) this.expel(o, m, 1000, "replaced");

    console.log(`hello ${pass} · ${kind}${card.sessions ? ` · ${card.sessions.length} сессий` : ""} · proto ${f.proto}`);
    if (kind === "keeper") ws.send(this.rosterText());
    else this.broadcastRoster();
    if (kind === "host" && !previous.length) void this.journal("machine.back", c.machine);
  }

  // ---------- кадр участника ----------

  private onFrame(ws: WebSocket, c: Member, text: string) {
    const f = parseFrame(text);
    if (!f) return refuse("bad_frame", "не кадр", c, { type: "кадр", id: idOf(text) }, ws);

    const from = f.from ?? c.addr;
    const mayClaim = from === c.addr || (kindOf(from) === "session" && `@${machineOf(from)}` === c.addr);
    if (!mayClaim) return refuse("bad_from", `from=${f.from}`, c, f, ws);
    if (f.type === "session.state") return this.onSessionState(ws, c, f);

    const to = addressesOf(f);
    if (typeof to === "string") return refuse("bad_frame", to, c, f, ws);
    if (!this.sendTo({ ...f, from }, to)) refuse("offline", `→ ${to.join(",")}`, c, f, ws);
  }

  private onSessionState(ws: WebSocket, c: Member, f: Frame) {
    if (c.kind !== "host") return refuse("bad_from", "session.state не от своего Host", c, f, ws);
    const { type: _type, id: _id, v: _v, to: _to, from: _from, ...record } = f;
    const { callsign } = record;
    if (!isSessionOf(callsign, c.machine)) return refuse("bad_from", `callsign ${callsign}`, c, f, ws);

    const sessions = c.sessions ?? [];
    const at = sessions.findIndex((s) => s.callsign === callsign);
    const next = record.state === null ? sessions.filter((s) => s.callsign !== callsign) : at < 0 ? [...sessions, record as SessionRecord] : sessions.with(at, record as SessionRecord);
    const tooBig = stamp(ws, { ...c, sessions: next });
    if (tooBig) return refuse("bad_frame", tooBig, c, f, ws);
    this.broadcastRoster();
  }
}
