// Поддельный relay: WebSocket для клиента link внутри процесса. Принимает hello, отвечает roster,
// записывает кадры Host, доставляет кадры и запросы, рвёт соединение и отказывает словом.
import type { Frame } from "@switchboard/protocol";
import type { WsCtor, WsLike } from "@switchboard/relay";

type L = { open: Array<() => void>; error: Array<() => void>; message: Array<(e: { data: unknown }) => void>; close: Array<(e: { code: number; reason: string }) => void> };

class FakeWs implements WsLike {
  readyState = 0;
  readonly url: string;
  private l: L = { open: [], error: [], message: [], close: [] };
  private relay: FakeRelay;

  constructor(relay: FakeRelay, url: string) {
    this.relay = relay;
    this.url = url;
    queueMicrotask(() => {
      if (this.readyState !== 0) return;
      this.readyState = 1;
      for (const f of this.l.open) f();
    });
    relay.connect(this);
  }

  addEventListener(type: keyof L, fn: never): void {
    (this.l[type] as unknown[]).push(fn);
  }

  send(data: string): void {
    if (this.readyState !== 1) throw new Error("сокет не открыт");
    this.relay.receive(this, data);
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState >= 2) return;
    this.readyState = 3;
    this.relay.closedByClient(this, code, reason);
    queueMicrotask(() => {
      for (const f of this.l.close) f({ code, reason });
    });
  }

  /** Сервер шлёт текст. */
  deliver(text: string): void {
    if (this.readyState !== 1) return;
    for (const f of this.l.message) f({ data: text });
  }

  /** Сервер закрыл соединение. */
  drop(code: number, reason: string): void {
    if (this.readyState >= 2) return;
    this.readyState = 3;
    queueMicrotask(() => {
      for (const f of this.l.close) f({ code, reason });
    });
  }
}

export class FakeRelay {
  /** конструктор WebSocket для link */
  readonly WebSocket: WsCtor;
  /** соединения по порядку */
  conns: FakeWs[] = [];
  /** все кадры от Host, включая hello */
  sent: Frame[] = [];
  hellos: Frame[] = [];
  /** закрытия соединений Host: код и причина */
  clientCloses: Array<{ code: number; reason: string }> = [];
  /** следующие hello закрыть этими словами (1008) */
  refuse: string[] = [];
  /** отвечать pong на ping */
  pongs = true;
  /** придержать roster после hello: связь с relay «ещё не готова», как при живом старте Host; отдать — releaseRoster() */
  holdRoster = false;
  private held: Array<() => void> = [];
  /** время hello машины: since в roster */
  since = 1730296931000;
  private seq = 0;
  private waits = new Map<string, (f: Frame) => void>();

  constructor() {
    const relay = this;
    this.WebSocket = class extends FakeWs {
      constructor(url: string) {
        super(relay, url);
      }
    } as unknown as WsCtor;
  }

  get current(): FakeWs | undefined {
    const c = this.conns.at(-1);
    return c && c.readyState === 1 ? c : undefined;
  }

  /** отдать придержанные roster */
  releaseRoster(): void {
    this.holdRoster = false;
    for (const g of this.held.splice(0)) g();
  }

  connect(ws: FakeWs): void {
    this.conns.push(ws);
  }

  closedByClient(_ws: FakeWs, code: number, reason: string): void {
    this.clientCloses.push({ code, reason });
  }

  receive(ws: FakeWs, text: string): void {
    if (text === "ping") {
      if (this.pongs) ws.deliver("pong");
      return;
    }
    const f = JSON.parse(text) as Frame;
    if (f.type === "hello") {
      const word = this.refuse.shift();
      if (word) {
        this.hellos.push(f);
        ws.drop(1008, word);
        return;
      }
      this.hellos.push(f);
      this.sent.push(f);
      this.since++;
      const give = () => ws.deliver(JSON.stringify(this.roster(f)));
      if (this.holdRoster) this.held.push(give);
      else give();
      return;
    }
    this.sent.push(f);
    if (f.type === "reply" && typeof f.id === "string") {
      const w = this.waits.get(f.id);
      this.waits.delete(f.id);
      w?.(f);
    }
  }

  /** roster после hello: машина Host и её сессии как есть. */
  roster(hello: Frame, extra: Partial<{ machines: object[]; clients: string[] }> = {}): Frame {
    const machine = String(hello.key ?? "").split(".")[1] ?? "laptop";
    return {
      type: "roster",
      machines: [{ machine, since: this.since, proto: 1, sdk: hello.sdk, contract: hello.contract }, ...(extra.machines ?? [])],
      sessions: (hello.sessions as object[]) ?? [],
      clients: extra.clients ?? ["phone", "panel-desk"],
      workers: [],
    };
  }

  /** Кадр от relay в Host. */
  deliver(f: Frame): void {
    this.current?.deliver(JSON.stringify(f));
  }

  /** Запрос клиента к Host: ответ — reply с тем же id. */
  request(f: Omit<Frame, "id"> & { id?: string }): Promise<Frame> {
    const id = f.id ?? `t-${++this.seq}`;
    const p = new Promise<Frame>((r) => this.waits.set(id, r));
    this.deliver({ from: "panel-desk", ...f, id } as Frame);
    return p;
  }

  /** Сервер рвёт соединение. */
  drop(code = 1006, reason = ""): void {
    this.current?.drop(code, reason);
  }

  /** Кадры Host этого типа. */
  frames(type: string): Frame[] {
    return this.sent.filter((f) => f.type === type);
  }
}
