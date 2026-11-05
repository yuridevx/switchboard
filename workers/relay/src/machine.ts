// Объект relay машины m/<машина>: соединения с карточками, hello через gate, roster, доставка.
// Держит её Host и keeper и гостей — Host других машин, устройства, программы. Доставляет только своей машине и гостям.
// На диск не пишет: всё — в карточках живых соединений (attachment платформы).
import { DurableObject } from "cloudflare:workers";
import { CALL_MS, fail, parseFrame, within } from "@switchboard/protocol";
import type { Frame } from "@switchboard/protocol";
import type { GateApi } from "@switchboard/gate";
import { addressOf, admit, ownCallsign, passId, rosterOf, tooBig, withSession, type Card, type HostCard } from "./card.ts";
import { isOwnName, senderOf, targetsOf, type Refusal } from "./route.ts";

export type Env = {
  FLEET: DurableObjectNamespace<Fleet>;
  GATE: GateApi;
  /** журнал: вход и уход Host своей машины пишет relay */
  LEDGER: { frame(f: Frame): Frame[] | Promise<Frame[]> };
  /** версии контракта relay, которые принимает hello */
  PROTO: number[];
  /** версия Worker'а от платформы (version_metadata): карточка помнит, каким кодом принято соединение */
  CF_VERSION?: { id: string };
  /** предел вызова по привязке (gate, журнал), мс; только стенд — в бою CALL_MS протокола */
  CALL_MS?: number;
};

/** Запись в attachment: до hello только версия кода, принявшего сокет; после — карточка и версия. */
type Attachment = { ver?: string } & Partial<Card>;
type Conn = { ws: WebSocket; card: Card };

const OPEN = 1;
const log = (line: string) => console.log(line);
const attachment = (ws: WebSocket) => ws.deserializeAttachment() as Attachment | null;
/** Карточка принятого hello; до hello её нет. */
const cardOf = (ws: WebSocket): Card | null => {
  const a = attachment(ws);
  return a && "role" in a ? (a as Card) : null;
};
/** role.name.kid пропуска — без секрета: секрет в журнал не попадает. */
const keyId = (key: string) => key.split(".").slice(0, 3).join(".").slice(0, 80);
/** Кто пишет в журнале до адреса: роль и имя пропуска. */
const shortName = (card: Card) => `${card.role}.${card.name}`;

/** id кадра, который не прошёл разбор, — чтобы ответить bad_frame. */
function idOf(text: string): string | undefined {
  try {
    const id = (JSON.parse(text) as { id?: unknown } | null)?.id;
    return typeof id === "string" ? id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Ответ вызова по привязке: копия значения, а сам результат освобождён сразу.
 * Неосвобождённый результат держит сессию вызова — объект не засыпает.
 */
export async function call<T>(p: T | Promise<T>): Promise<T> {
  const r = await p;
  if (!r || typeof r !== "object") return r;
  const copy = structuredClone(r);
  (r as { [Symbol.dispose]?: () => void })[Symbol.dispose]?.();
  return copy;
}

export class Fleet extends DurableObject<Env> {
  private ready: Promise<void>;
  /** соединения, чей hello сейчас проверяет gate */
  private verifying = new Set<WebSocket>();
  private machine: string;
  /** свои Host на связи — по ним relay пишет в журнал вход и уход машины */
  private present = new Set<string>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.machine = (ctx.id.name ?? "").slice("m/".length);
    // ping → pong отвечает Cloudflare, объект не просыпается
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    this.present = this.hosts();
    this.ready = this.closePreviousCode();
  }

  async fetch(): Promise<Response> {
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    // версия кода, принявшего сокет: hello, потерянный при смене кода, не держит соединение без карточки
    server.serializeAttachment({ ver: this.version });
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, msg: string | ArrayBuffer): Promise<void> {
    const text = typeof msg === "string" ? msg : "";
    const f = parseFrame(text);
    try {
      await this.ready;
      // старт объекта закрыл отправителя (прежний код relay): кадр потерян, как и прочие кадры в пути
      if (ws.readyState !== OPEN) return;
      const card = cardOf(ws);
      if (card) return await this.onFrame({ ws, card }, f, text);
      if (f?.type !== "hello" || this.verifying.has(ws)) {
        log(`bad_frame до hello · ${f?.type ?? "?"}`);
        return ws.close(1008, "bad_frame");
      }
      await this.hello(ws, f);
    } catch (e) {
      this.crash(e, `webSocketMessage(${f?.type ?? "?"})`);
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      await this.ready;
      const card = cardOf(ws);
      if (!card) return;
      log(`close ${shortName(card)} · ${code}${reason ? " " + reason : ""}`);
      // keeper в roster не входит: его уход roster не меняет
      if (card.role !== "keeper") await this.membersChanged(ws);
    } catch (e) {
      this.crash(e, "webSocketClose");
    }
  }

  async webSocketError(ws: WebSocket, err: unknown): Promise<void> {
    const card = cardOf(ws);
    log(`error ${card ? shortName(card) : "до hello"} · ${err}`);
  }

  /** Отзыв пропуска: закрыть соединения с этим номером словом revoked. Ответ — сколько закрыто. */
  async revoke(kid: string): Promise<number> {
    await this.ready;
    const gone = this.conns().filter((c) => c.card.kid === kid);
    for (const { ws, card } of gone) {
      log(`revoked ${shortName(card)}.${kid} · закрыт отзывом`);
      ws.close(1008, "revoked");
    }
    if (gone.length) await this.membersChanged();
    return gone.length;
  }

  /** Кадр Worker'а по привязке: доставка своей машине; from ставит вызывающий. Ответ — сколько получателей. */
  async deliver(f: Frame): Promise<number> {
    await this.ready;
    const targets = targetsOf(this.conns(), f);
    const list = Array.isArray(targets) ? targets : [];
    const text = JSON.stringify(f);
    for (const { ws } of list) ws.send(text);
    log(`${list.length ? "deliver" : "offline"} ${String(f.from)} → ${String(f.to)} · ${f.type}`);
    return list.length;
  }

  // ---------- hello ----------

  private async hello(ws: WebSocket, f: Frame): Promise<void> {
    const key = typeof f.key === "string" ? f.key : "";
    this.verifying.add(ws);
    let pass;
    try {
      pass = await within(call(this.env.GATE.verify(key)), `gate не ответил за ${this.callMs / 1000} с`, this.callMs);
    } catch (e) {
      log(`gate ${keyId(key)} · gate_unavailable · ${e}`);
      return ws.close(1008, "gate_unavailable");
    } finally {
      this.verifying.delete(ws);
    }
    if (ws.readyState !== OPEN) return; // ушёл, пока gate проверял
    if ("error" in pass) {
      log(`${pass.error} ${keyId(key)}`);
      return ws.close(1008, pass.error);
    }
    if (typeof f.proto !== "number" || !this.env.PROTO.includes(f.proto)) {
      log(`contract_mismatch ${passId(pass)} · proto ${JSON.stringify(f.proto)} · relay ${JSON.stringify(this.env.PROTO)}`);
      return ws.close(1008, "contract_mismatch");
    }
    const admission = admit(pass, f, this.machine, f.proto, Date.now());
    if ("word" in admission) {
      log(admission.line);
      return ws.close(1008, admission.word);
    }
    const { card } = admission;
    this.replacePrevious(ws, card);
    ws.serializeAttachment({ ...card, ver: this.version });
    log(`hello ${passId(pass)} · ${card.role}${card.role === "host" ? ` · ${card.sessions.length} сессий` : ""} · proto ${card.proto}`);
    // keeper в roster не входит: roster — только ему, как знак, что hello принят; флот не меняется
    if (card.role === "keeper") ws.send(JSON.stringify(rosterOf(this.conns().map((c) => c.card))));
    else await this.membersChanged();
  }

  /**
   * Машина одна: новый hello той же машины в той же роли вытесняет прежний. Карточка снимается сразу: оборвавшийся сокет
   * на close не отвечает, и после сна объекта платформа снова показывает его открытым.
   */
  private replacePrevious(ws: WebSocket, card: Card): void {
    if (card.role === "client") return;
    for (const old of this.conns()) {
      if (old.ws !== ws && old.card.role === card.role && old.card.name === card.name) {
        log(`replaced ${shortName(old.card)}.${old.card.kid}`);
        old.ws.serializeAttachment({ ver: this.version });
        old.ws.close(1000, "replaced");
      }
    }
  }

  // ---------- кадр после hello ----------

  private async onFrame(sender: Conn, f: Frame | null, text: string): Promise<void> {
    if (!f) {
      log(`bad_frame ${shortName(sender.card)} · не кадр`);
      const id = idOf(text);
      if (id) sender.ws.send(JSON.stringify(fail(id, "bad_frame")));
      return;
    }
    const refused = await this.route(sender, f);
    if (!refused) return;
    log(`${refused.word} ${addressOf(sender.card)} · ${f.type}${refused.why ? " · " + refused.why : ""}`);
    if (f.id) sender.ws.send(JSON.stringify(fail(f.id, refused.word)));
  }

  private async route(sender: Conn, f: Frame): Promise<Refusal | void> {
    const who = senderOf(sender.card, f);
    if ("word" in who) return who;
    if (isOwnName(f.type)) return f.type === "session.state" ? this.sessionState(sender, f) : { word: "bad_frame", why: "имя relay" };
    const targets = targetsOf(this.conns(), f);
    if (!Array.isArray(targets)) return targets;
    const text = JSON.stringify({ ...f, from: who.from });
    for (const { ws } of targets) ws.send(text);
  }

  private async sessionState(sender: Conn, f: Frame): Promise<Refusal | void> {
    if (sender.card.role !== "host") return { word: "bad_from", why: "session.state не от своего Host" };
    const card: HostCard = sender.card;
    if (!ownCallsign(f.callsign, card.name)) return { word: "bad_from", why: `callsign ${String(f.callsign)}` };
    const next = withSession(card, f);
    const big = tooBig(next);
    if (big) return { word: "bad_frame", why: big };
    sender.ws.serializeAttachment(next);
    this.broadcast();
  }

  // ---------- состав ----------

  /** Живые соединения с принятым hello. */
  private conns(except?: WebSocket): Conn[] {
    const list: Conn[] = [];
    for (const ws of this.ctx.getWebSockets()) {
      const card = ws === except || ws.readyState !== OPEN ? null : cardOf(ws);
      if (card) list.push({ ws, card });
    }
    return list;
  }

  private hosts(except?: WebSocket): Set<string> {
    return new Set(this.conns(except).filter((c) => c.card.role === "host").map((c) => c.card.name));
  }

  /** roster — всем соединениям, кроме keeper: ему — только первый, при входе. */
  private broadcast(except?: WebSocket): void {
    const conns = this.conns(except);
    const text = JSON.stringify(rosterOf(conns.map((c) => c.card)));
    for (const { ws, card } of conns) if (card.role !== "keeper") ws.send(text);
  }

  /** Состав соединений изменился: вход и уход своих Host — в журнал, roster — всем. */
  private async membersChanged(except?: WebSocket): Promise<void> {
    const now = this.hosts(except);
    const back = [...now].filter((m) => !this.present.has(m));
    const left = [...this.present].filter((m) => !now.has(m));
    this.present = now;
    await Promise.all([...back.map((m) => this.journal("machine.back", m)), ...left.map((m) => this.journal("machine.left", m))]);
    this.broadcast(except);
  }

  /** Запись журнала о своей машине: текст пишет журнал по своим прежним записям. Журнал не ответил — строка здесь. */
  private async journal(ev: "machine.back" | "machine.left", machine: string): Promise<void> {
    log(`${ev} ${machine}`);
    try {
      await within(call(this.env.LEDGER.frame({ type: "ledger.add", v: 1, to: ".ledger", ev, machine, from: ".relay" })), `журнал не ответил за ${this.callMs / 1000} с`, this.callMs);
    } catch (e) {
      log(`offline relay → .ledger · ${ev} ${machine} · ${e}`);
    }
  }

  // ---------- старт и сбой ----------

  /** Предел вызова по привязке — CALL_MS протокола (стенд ставит меньше). */
  private get callMs(): number {
    return this.env.CALL_MS ?? CALL_MS;
  }

  /** Версия кода relay; без привязки — пустая. */
  private get version(): string {
    return this.env.CF_VERSION?.id ?? "";
  }

  /**
   * Старт объекта: соединения, принятые прежним кодом relay, — закрыть словом relay_updated: выпуск relay спящие
   * веб-сокеты не рвёт, и кадры, бывшие в пути при смене кода, теряются молча; клиенты переподключаются по ветке
   * устава «соединение оборвалось», keeper спрашивает план заново, ждущие запросы получают disconnected.
   */
  private async closePreviousCode(): Promise<void> {
    const stale = this.ctx.getWebSockets().filter((ws) => ws.readyState === OPEN && attachment(ws)?.ver !== this.version);
    for (const ws of stale) ws.close(1012, "relay_updated");
    if (!stale.length) return;
    log(`relay_updated · закрыто соединений прежнего кода relay: ${stale.length}`);
    await this.membersChanged();
  }

  /** Ошибка в коде relay: строка в журнале и чистый перезапуск объекта. */
  private crash(e: unknown, where: string): never {
    log(`abort ${e instanceof Error ? (e.stack ?? e.message) : String(e)} · ${where}`);
    this.ctx.abort(String(e));
    throw e;
  }
}
