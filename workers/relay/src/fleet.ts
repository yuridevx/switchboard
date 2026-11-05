// Объект машины: соединения с карточками в attachments платформы, roster из живых карточек, доставка по адресу. На диск не пишет.
import { DurableObject } from "cloudflare:workers";
import { CALL_MS, fail, hostOf, kindOf, machineOf, parseFrame, reaches, within, type Frame } from "@switchboard/protocol";
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

/** Карточка без входа: hello не было, он у gate (checking) или соединение уже вытеснено и отозвано, а платформа ещё показывает сокет. */
type Bare = { ver: string; checking?: boolean };
/** Карточка участника: row и sessions — только у своего Host объекта. */
type Member = Bare & { addr: string; kid: string; kind: "host" | "guest" | "keeper" | "client"; row?: RosterMachine; sessions?: SessionRecord[] };

const OPEN = 1;

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

/** Записать карточку; предел знает платформа. Не влезла — причина. */
function stamp(ws: WebSocket, card: Member): string | null {
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

/** Отказ участнику: строка журнала, кадру с id — ответ. */
function refuse(ws: WebSocket, c: Member, f: { type: string; id?: string }, word: string, why: string) {
  console.log(`${word} ${c.addr} · ${f.type} · ${why}`);
  if (f.id) ws.send(JSON.stringify(fail(f.id, word)));
}

export class Fleet extends DurableObject<Env> {
  private readonly ver: string;
  private readonly machine: string;
  private readonly callMs: number;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ver = env.CF_VERSION?.id ?? "";
    this.machine = (ctx.id.name ?? "").slice("m/".length);
    this.callMs = env.CALL_MS ?? CALL_MS;
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    this.closePreviousCode();
  }

  /** Выпуск relay спящие сокеты не рвёт, кадры прежнего кода теряются: при старте объекта такие соединения закрываются, клиенты входят заново. */
  private closePreviousCode() {
    const stale = this.ctx.getWebSockets().filter((ws) => ws.readyState === OPEN && !this.card(ws));
    for (const ws of stale) {
      if ((ws.deserializeAttachment() as Member | null)?.kind === "host") void this.journal("machine.left");
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
      const c = ws.readyState === OPEN ? this.card(ws) : null;
      return c && "addr" in c ? [[ws, c as Member]] : [];
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

  /** Вход и уход машины: текст пишет журнал по своим прежним записям. Журнал никого не задерживает: не ответил — строка здесь. */
  private async journal(ev: "machine.back" | "machine.left") {
    console.log(`${ev} ${this.machine}`);
    try {
      await this.call("журнал", this.env.LEDGER.frame({ type: "ledger.add", v: 1, to: ".ledger", ev, machine: this.machine, from: ".relay" }));
    } catch (e) {
      console.log(`offline relay → .ledger · ${ev} ${this.machine} · ${e}`);
    }
  }

  /** Снять участника: сокет из состава сразу, закрытие могло и не дойти. */
  private unseat(ws: WebSocket) {
    ws.serializeAttachment({ ver: this.ver } satisfies Bare);
  }

  private afterLeaving(c: Member) {
    if (c.kind !== "keeper") this.broadcastRoster();
    if (c.kind === "host") void this.journal("machine.left");
  }

  private sendTo(f: Frame, to: string[]): number {
    const text = JSON.stringify(f);
    const receivers = this.members().filter(([, c]) => to.some((a) => arrives(a, c)));
    for (const [ws] of receivers) ws.send(text);
    return receivers.length;
  }

  /** Ошибка в коде relay: причина в журнал и чистый перезапуск объекта, соединения входят заново. */
  private async guarded(where: string, work: () => void | Promise<void>) {
    try {
      await work();
    } catch (e) {
      console.log(`abort ${(e as Error).stack ?? e} · ${where}`);
      this.ctx.abort(String(e));
    }
  }

  // ---------- вход платформы ----------

  fetch(): Response {
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ ver: this.ver } satisfies Bare);
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const text = String(message);
    return this.guarded(`webSocketMessage(${parseFrame(text)?.type ?? "?"})`, () => {
      const c = ws.readyState === OPEN ? this.card(ws) : null;
      if (!c) return;
      return "addr" in c ? this.onFrame(ws, c as Member, text) : this.onHello(ws, c, text);
    });
  }

  webSocketClose(ws: WebSocket, code: number, reason: string) {
    return this.guarded("webSocketClose", () => this.onGone(ws, `${code} ${reason}`));
  }

  /** Соединение порвала ошибка, а не закрытие: ветка та же. */
  webSocketError(ws: WebSocket, e: unknown) {
    return this.guarded("webSocketError", () => this.onGone(ws, String(e)));
  }

  private onGone(ws: WebSocket, why: string) {
    const c = this.card(ws);
    if (!c || !("addr" in c)) return;
    const member = c as Member;
    this.unseat(ws);
    console.log(`close ${member.addr} ${member.kid} · ${why}`);
    this.afterLeaving(member);
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
    for (const [ws, c] of hit) {
      this.unseat(ws);
      ws.close(1008, "revoked");
      console.log(`revoked ${c.addr} ${kid}`);
    }
    for (const [, c] of hit) this.afterLeaving(c);
    return hit.length;
  }

  // ---------- hello ----------

  private async onHello(ws: WebSocket, c: Bare, text: string) {
    const f = parseFrame(text);
    if (f?.type !== "hello" || c.checking) {
      console.log(`bad_frame до hello · ${f?.type ?? "?"}`);
      return ws.close(1008, "bad_frame");
    }
    ws.serializeAttachment({ ...c, checking: true } satisfies Bare);

    const key = String(f.key ?? "");
    // в журнал — пропуск без секрета
    const pass = key.split(".").slice(0, -1).join(".").slice(0, 80);
    const shut = (word: string, why = "") => {
      console.log(`${word} ${pass}${why && ` · ${why}`}`);
      ws.close(1008, word);
    };

    const who = await this.call("gate", this.env.GATE.verify(key)).catch((e) => ({ error: "gate_unavailable", why: String(e) }));
    if (ws.readyState !== OPEN) return;
    if ("error" in who) return shut(who.error, "why" in who ? who.why : "");
    if (!this.env.PROTO.includes(f.proto as number)) return shut("contract_mismatch", `proto ${JSON.stringify(f.proto)} · relay ${JSON.stringify(this.env.PROTO)}`);

    const own = who.role === "host" && who.name === this.machine;
    if (f.part !== undefined && (f.part !== "keeper" || !own)) return shut("bad_frame", `part ${JSON.stringify(f.part)} — в relay своей машины входит только keeper пропуском машины`);
    const kind = f.part ? "keeper" : own ? "host" : who.role === "host" ? "guest" : "client";

    const card: Member = { ver: this.ver, kid: who.kid, kind, addr: kind === "keeper" ? `.keeper@${this.machine}` : who.addr };
    if (kind === "host") {
      const sessions = f.sessions ?? [];
      if (!Array.isArray(sessions) || !sessions.every((s) => isSessionOf(s?.callsign, this.machine))) return shut("bad_from", `в hello callsign не машины ${this.machine}`);
      card.sessions = sessions;
      card.row = { machine: this.machine, since: Date.now(), proto: f.proto as number, sdk: f.sdk as string | undefined, contract: f.contract as Record<string, number> | undefined };
    }
    const tooBig = stamp(ws, card);
    if (tooBig) return shut("bad_frame", tooBig);

    // у пропуска машины соединение одно; устройств человека может быть несколько
    const previous = kind === "client" ? [] : this.members().filter(([o, m]) => o !== ws && m.addr === card.addr);
    for (const [o, m] of previous) {
      this.unseat(o);
      o.close(1000, "replaced");
      console.log(`replaced ${m.addr} ${m.kid}`);
    }

    console.log(`hello ${pass} · ${kind}${card.sessions ? ` · ${card.sessions.length} сессий` : ""} · proto ${f.proto}`);
    if (kind === "keeper") ws.send(this.rosterText());
    else this.broadcastRoster();
    if (kind === "host" && !previous.length) void this.journal("machine.back");
  }

  // ---------- кадр участника ----------

  private onFrame(ws: WebSocket, c: Member, text: string) {
    const f = parseFrame(text);
    if (!f) return refuse(ws, c, { type: "?", id: idOf(text) }, "bad_frame", "не кадр");

    const from = f.from ?? c.addr;
    const mayClaim = from === c.addr || (kindOf(from) === "session" && `@${machineOf(from)}` === c.addr);
    if (!mayClaim) return refuse(ws, c, f, "bad_from", `from=${f.from}`);
    if (f.type === "session.state") return this.onSessionState(ws, c, f);

    const to = addressesOf(f);
    if (typeof to === "string") return refuse(ws, c, f, "bad_frame", to);
    if (!this.sendTo({ ...f, from }, to)) refuse(ws, c, f, "offline", `→ ${to.join(",")}`);
  }

  private onSessionState(ws: WebSocket, c: Member, f: Frame) {
    if (c.kind !== "host") return refuse(ws, c, f, "bad_from", "session.state не от своего Host");
    const { type: _type, id: _id, v: _v, to: _to, from: _from, ...record } = f;
    const { callsign } = record;
    if (!isSessionOf(callsign, this.machine)) return refuse(ws, c, f, "bad_from", `callsign ${callsign}`);

    const sessions = c.sessions ?? [];
    const at = sessions.findIndex((s) => s.callsign === callsign);
    const next = record.state === null ? sessions.filter((s) => s.callsign !== callsign) : at < 0 ? [...sessions, record as SessionRecord] : sessions.with(at, record as SessionRecord);
    const tooBig = stamp(ws, { ...c, sessions: next });
    if (tooBig) return refuse(ws, c, f, "bad_frame", tooBig);
    this.broadcastRoster();
  }
}
