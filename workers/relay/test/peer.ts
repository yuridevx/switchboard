// Соединение с relay внутри workerd для тестов: hello, кадры по одному, закрытие.
import { SELF, env } from "cloudflare:test";

import { SECRET, standPass } from "./sign.ts";
type F = Record<string, any>;

/** Пропуск стенда: строка в базе gate стенда. Номер по умолчанию — свой у каждого имени (номер в базе один). */
export const key = (role: "host" | "client", name: string, kid = `k-${name}`, secret = SECRET) =>
  standPass((env as unknown as { GATE_DB: Parameters<typeof standPass>[0] }).GATE_DB, role, name, kid, secret);

export class Peer {
  frames: F[] = [];
  raw: string[] = [];
  closed: { code: number; reason: string } | null = null;

  ws: WebSocket;
  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener("message", (ev) => {
      const t = String(ev.data);
      this.raw.push(t);
      if (t !== "pong") this.frames.push(JSON.parse(t));
    });
    ws.addEventListener("close", (ev) => {
      this.closed = { code: ev.code, reason: ev.reason };
    });
  }

  /** Соединение с объектом машины; по умолчанию — laptop: Host других машин входят к нему гостями. */
  static async open(machine = "laptop"): Promise<Peer> {
    const res = await SELF.fetch(`https://switchboard.test/m/${machine}`, { headers: { Upgrade: "websocket" } });
    const ws = res.webSocket!;
    ws.accept();
    return new Peer(ws);
  }

  /** Новое соединение, hello и первый roster. */
  static async hello(role: "host" | "keeper" | "client", name: string, extra: F = {}, kid?: string): Promise<Peer> {
    const p = await Peer.open();
    // keeper входит ключом машины и называет себя part
    const k = role === "keeper" ? await key("host", name, kid) : await key(role, name, kid);
    p.send({ type: "hello", proto: 1, key: k, ...(role === "keeper" ? { part: "keeper" } : {}), ...extra });
    // первый roster остаётся в очереди: его читает roster()
    await p.until(() => p.frames.find((f) => f.type === "roster"), 3000, "roster после hello");
    return p;
  }

  send(f: F | string) {
    this.ws.send(typeof f === "string" ? f : JSON.stringify(f));
  }

  async until<T>(get: () => T | undefined, ms: number, what: string): Promise<T> {
    const end = Date.now() + ms;
    for (;;) {
      const v = get();
      if (v !== undefined) return v;
      if (Date.now() > end) throw new Error(`не дождались: ${what}`);
      // только опрос по таймеру: обещание, разрешённое из обработчика сокета, в workerd не доходит до теста
      await new Promise<void>((r) => setTimeout(r, 10));
    }
  }

  /** Следующий кадр по условию — забирает его из очереди. */
  next(pred: (f: F) => boolean = () => true, ms = 3000): Promise<F> {
    return this.until(
      () => {
        const i = this.frames.findIndex(pred);
        return i < 0 ? undefined : this.frames.splice(i, 1)[0];
      },
      ms,
      "кадр",
    );
  }

  /** Последний roster из очереди; нет ни одного — ждёт новый. Очередь roster-кадров очищается. */
  async roster(ms = 3000): Promise<F> {
    await this.until(() => this.frames.find((f) => f.type === "roster"), ms, "roster");
    const all = this.frames.filter((f) => f.type === "roster");
    this.frames = this.frames.filter((f) => f.type !== "roster");
    return all[all.length - 1];
  }

  waitClose(ms = 3000) {
    return this.until(() => this.closed ?? undefined, ms, "закрытие");
  }

  /** Подождать и убедиться, что кадров нет. */
  async quiet(ms = 150): Promise<F[]> {
    await new Promise((r) => setTimeout(r, ms));
    return this.frames.filter((f) => f.type !== "roster");
  }

  close(code = 1000, reason = "bye") {
    try {
      this.ws.close(code, reason);
    } catch {
      // уже закрыто
    }
  }
}

export const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Ждать, пока условие не станет истинным. */
export async function eventually<T>(get: () => Promise<T | undefined> | T | undefined, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await get();
    if (v !== undefined && v !== false) return v;
    if (Date.now() > end) throw new Error("не дождались условия");
    await wait(20);
  }
}

export const fleet = (machine = "laptop") => env.FLEET.get(env.FLEET.idFromName(`m/${machine}`));
