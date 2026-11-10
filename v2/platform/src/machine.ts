// Объект машины: соединения её Host, Keeper и зрителей; доставка кадров и ответов. Один на машину; своих записей не ведёт.
import { DurableObject } from "cloudflare:workers";
import { CALL_MS, fail, type Frame, isReply, kindOf, machineAddr, machineOf, parseFrame, parsePass, PROTO, type Reply, type SessionRow } from "@sb/protocol";
import { type Card, cardOf, type Drop, type Env, fleetStub, helloLimit, log, machineStub, send, shut } from "./env.ts";

type Live = Extract<Card, { kid: string }>;
type Waiting = { resolve: (r: Reply) => void; role: "host" | "keeper"; timer: ReturnType<typeof setTimeout> };

/** Запросы, которые зритель шлёт своим соединением: уходят Host с адресом зрителя. */
const WATCHER_ASKS = new Set(["session.watch", "session.unwatch", "session.read"]);

export class MachineObject extends DurableObject<Env> {
  /** кто ждёт ответ Host или Keeper по id запроса */
  private pending = new Map<string, Waiting>();
  /** вход соединения в работе: кадры, пришедшие до его конца, ждут */
  private entering = new Map<WebSocket, Promise<void>>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  private find(role: "host" | "keeper"): WebSocket | null {
    for (const ws of this.ctx.getWebSockets()) if (cardOf(ws).role === role) return ws;
    return null;
  }

  /** Отдать кадр-запрос и дождаться ответа по id; предел — CALL_MS. */
  private ask(ws: WebSocket, role: "host" | "keeper", f: Frame): Promise<Reply> {
    const id = f.id!;
    return new Promise<Reply>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(fail(id, "timeout", "машина не ответила за отведённое время"));
      }, CALL_MS);
      this.pending.set(id, { resolve, role, timer });
      send(ws, f);
    });
  }

  private settle(r: Reply): void {
    const w = this.pending.get(r.id);
    if (!w) return;
    this.pending.delete(r.id);
    clearTimeout(w.timer);
    w.resolve(r);
  }

  /** Кадр сессии, машине или keeper этой машины. С id — ждёт ответ; без id — null. Адресат не на связи — отказ offline. */
  async deliver(fleet: string, machine: string, f: Frame): Promise<Reply | null> {
    const t0 = Date.now();
    const to = typeof f.to === "string" ? f.to : "";
    const role = kindOf(to) === "keeper" ? "keeper" : "host";
    const ws = this.find(role);
    if (!ws) {
      log.info("доставка: адресат не на связи", { fleet, machine, type: f.type, trace: f.trace, to, ok: false, word: "offline" });
      return f.id ? { ...fail(f.id, "offline", (role === "keeper" ? "Keeper" : "Host") + " машины " + machine + " не на связи"), trace: f.trace, spans: [{ part: "platform", ms: Date.now() - t0 }] } : null;
    }
    if (!f.id) {
      send(ws, f);
      return null;
    }
    const r = await this.ask(ws, role, f);
    const ms = Date.now() - t0;
    log.info("доставка", { fleet, machine, type: f.type, trace: f.trace, from: f.from, to, ms, ok: r.ok, ...(r.ok ? {} : { word: r.error }) });
    return { ...r, trace: r.trace ?? f.trace, spans: [...(r.spans ?? []), { part: "platform", ms }] };
  }

  /** Кадр без ответа Host или Keeper; false — не на связи. */
  push(f: Frame, role: "host" | "keeper"): boolean {
    const ws = this.find(role);
    if (ws) send(ws, f);
    return !!ws;
  }

  /** Закрыть соединения отозванного пропуска и зрителей, у которых сменился доступ. */
  drop(d: Drop): void {
    for (const ws of this.ctx.getWebSockets()) {
      const c = cardOf(ws);
      if (c.role === "new" || c.role === "page") continue;
      const revoked = d.kids?.includes(c.kid), access = c.role === "watch" && d.persons?.includes(c.person);
      if (!revoked && !access) continue;
      this.left(ws, c);
      shut(ws, revoked ? "revoked" : "access");
    }
  }

  /** Соединение ушло: Host — машина «нет связи» и отказ ждущим; Keeper — пометка; зритель — весть Host. */
  private left(ws: WebSocket, c: Live): void {
    ws.serializeAttachment({ role: "new" } satisfies Card);
    const machine = c.machine!;
    const fleet = fleetStub(this.env, c.fleet);
    if (c.role === "host") {
      for (const [id, w] of this.pending) if (w.role === "host") this.settle(fail(id, "offline", "Host машины " + machine + " ушёл со связи"));
      this.ctx.waitUntil(fleet.rows(machine, { kind: "offline" }));
      log.info("Host ушёл со связи", { fleet: c.fleet, machine });
    } else if (c.role === "keeper") {
      for (const [id, w] of this.pending) if (w.role === "keeper") this.settle(fail(id, "offline", "Keeper машины " + machine + " ушёл со связи"));
      this.ctx.waitUntil(fleet.rows(machine, { kind: "keeper", on: false }));
    } else if (c.role === "watch") {
      const still = this.ctx.getWebSockets().some((o) => {
        const oc = cardOf(o);
        return o !== ws && oc.role === "watch" && oc.addr === c.addr;
      });
      const host = this.find("host");
      if (!still && host) send(host, { type: "watcher.gone", from: c.addr });
    }
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("нужен WebSocket", { status: 426 });
    const [, , fleet, machine] = new URL(request.url).pathname.split("/");
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment({ role: "new", fleet, machine } satisfies Card);
    helloLimit(pair[1], this.env);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  /** Первое сообщение соединения: кто это и можно ли ему сюда. */
  private async enter(ws: WebSocket, c: Extract<Card, { role: "new" }>, f: Frame): Promise<void> {
    const role = f.role;
    if (f.type !== "hello" || (role !== "host" && role !== "keeper" && role !== "watch") || !c.fleet || !c.machine) return shut(ws, "bad_frame");
    if (f.proto !== PROTO) return shut(ws, "proto");
    const pass = parsePass(f.key);
    if (!pass || pass.fleet !== c.fleet) return shut(ws, "bad_key");
    const who = await fleetStub(this.env, c.fleet).who(String(f.key));
    if ("error" in who) {
      log.warn("соединение не принято", { fleet: c.fleet, machine: c.machine, word: who.error, why: who.why });
      return shut(ws, who.error);
    }
    // Host и Keeper — только пропуском этой машины; зритель — устройство, которое до машины достаёт
    const allowed = role === "watch" ? kindOf(who.addr) === "device" && who.machines.includes(c.machine) : who.addr === machineAddr(c.machine);
    if (!allowed) {
      log.warn("соединение не принято", { fleet: c.fleet, machine: c.machine, from: who.addr, word: "forbidden" });
      return shut(ws, "forbidden");
    }
    if (role !== "watch") {
      const was = this.find(role);
      if (was) {
        // второй вытесняет первого: прежний не считается ушедшим
        was.serializeAttachment({ role: "new" } satisfies Card);
        shut(was, "replaced");
      }
    }
    ws.serializeAttachment({ role, kid: who.kid, addr: who.addr, person: who.person, admin: who.admin, fleet: c.fleet, machine: c.machine } satisfies Card);
    if (role === "keeper") await fleetStub(this.env, c.fleet).rows(c.machine, { kind: "keeper", on: true });
    send(ws, { type: "hello.ok", addr: who.addr });
    log.info("соединение принято", { fleet: c.fleet, machine: c.machine, from: who.addr, role });
  }

  override async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
    const entering = this.entering.get(ws);
    if (entering) await entering;
    const f = typeof data === "string" ? parseFrame(data) : null;
    const c = cardOf(ws);
    if (c.role === "new") {
      if (!f) return shut(ws, "bad_frame");
      const p = this.enter(ws, c, f).finally(() => this.entering.delete(ws));
      this.entering.set(ws, p);
      return p;
    }
    if (!f || c.role === "page") return;
    if (c.role === "watch") return this.fromWatcher(ws, c, f);
    if (isReply(f)) return this.settle(f);
    if (c.role === "host") return this.fromHost(ws, c, f);
  }

  private async fromWatcher(ws: WebSocket, c: Live, f: Frame): Promise<void> {
    if (!f.id) return;
    if (!WATCHER_ASKS.has(f.type) || typeof f.to !== "string" || kindOf(f.to) !== "session" || machineOf(f.to) !== c.machine) {
      return send(ws, { ...fail(f.id, "unknown_request", "этим соединением идут только session.watch, session.unwatch и session.read сессиям этой машины"), trace: f.trace });
    }
    const host = this.find("host");
    if (!host) return send(ws, { ...fail(f.id, "offline", "Host машины " + c.machine + " не на связи"), trace: f.trace });
    const t0 = Date.now();
    const r = await this.ask(host, "host", { ...f, from: c.addr });
    send(ws, { ...r, trace: r.trace ?? f.trace, spans: [...(r.spans ?? []), { part: "platform", ms: Date.now() - t0 }] });
  }

  private async fromHost(ws: WebSocket, c: Live, f: Frame): Promise<void> {
    const machine = c.machine!;
    const fleet = fleetStub(this.env, c.fleet);
    if (f.type === "machine.hello") {
      const sessions = (Array.isArray(f.sessions) ? (f.sessions as SessionRow[]) : []).filter((s) => s && machineOf(String(s.callsign)) === machine);
      await fleet.rows(machine, { kind: "snapshot", build: typeof f.build === "number" ? f.build : undefined, sdk: typeof f.sdk === "string" ? f.sdk : undefined, os: typeof f.os === "string" ? f.os : undefined, sessions });
      return;
    }
    if (f.type === "session.state") {
      if (typeof f.callsign === "string" && machineOf(f.callsign) === machine) await fleet.rows(machine, { kind: "delta", callsign: f.callsign, row: (f.row ?? null) as Partial<SessionRow> | null });
      return;
    }
    if (Array.isArray(f.to)) {
      // лента: зрителям по адресам
      const to = new Set(f.to);
      for (const o of this.ctx.getWebSockets()) {
        const oc = cardOf(o);
        if (oc.role === "watch" && to.has(oc.addr)) send(o, f);
      }
      return;
    }
    if (typeof f.to !== "string") return;
    const kind = kindOf(f.to);
    if (kind === "device" || kind === "person") {
      for (const o of this.ctx.getWebSockets()) {
        const oc = cardOf(o);
        if (oc.role === "watch" && (oc.addr === f.to || oc.person === f.to)) send(o, f);
      }
      return;
    }
    const other = machineOf(f.to);
    if (!other || other === machine) return;
    // кадр другой машине: отправитель — эта машина или её сессия, которую назвал Host
    const from = typeof f.from === "string" && machineOf(f.from) === machine ? f.from : c.addr;
    const t0 = Date.now();
    let r: Reply | null;
    if (!(await fleet.reaches(c.person, other))) r = f.id ? fail(f.id, "forbidden", "владелец машины " + machine + " не достаёт до " + other) : null;
    else r = await machineStub(this.env, c.fleet, other).deliver(c.fleet, other, { ...f, from });
    if (r) send(ws, { ...r, trace: r.trace ?? f.trace, spans: [...(r.spans ?? []), { part: "platform", ms: Date.now() - t0 }] });
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    const c = cardOf(ws);
    if (c.role !== "new" && c.role !== "page") this.left(ws, c);
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, reason);
    } catch {
      // уже закрыто
    }
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    const c = cardOf(ws);
    if (c.role !== "new" && c.role !== "page") this.left(ws, c);
  }
}
