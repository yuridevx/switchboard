// Леса тестов платформы: завести флот, выдать пропуска, подключить страницу, Host, Keeper и зрителя.
import { env, SELF } from "cloudflare:test";
import { type Frame, PROTO, type Reply, type SessionRow } from "@sb/protocol";
import type { Env } from "../src/env.ts";
import { platformApi } from "../src/index.ts";

export const E = env as unknown as Env;
export const api = platformApi(E);

let n = 0;
export const newFleet = (): string => "f" + ++n + "x" + Math.random().toString(36).slice(2, 8);

export const YURI = "~yuri@example.com", ANYA = "~anya@example.com", OLEG = "~oleg@example.com";

export async function redeem(invite: string): Promise<string> {
  const r = await api.fleetCall("", null, { type: "redeem", id: "r", invite });
  if (!r.ok) throw new Error("redeem: " + r.error);
  return (r.result as { key: string }).key;
}

/** Запрос объекту флота от имени пропуска. */
export async function ask(fleet: string, key: string, frame: Frame): Promise<Reply> {
  const who = await api.who(key);
  if ("error" in who) throw new Error("who: " + who.error);
  return api.fleetCall(fleet, who, { id: "q" + ++n, ...frame });
}

/** Завести флот; ответ — пропуск первого устройства админа. */
export async function boot(fleet: string, person = YURI): Promise<string> {
  const res = await SELF.fetch("https://p.test/boot", { method: "POST", headers: { authorization: "Bearer boot-secret" }, body: JSON.stringify({ fleet, person }) });
  const j = (await res.json()) as { ok: boolean; invite: string };
  if (!j.ok) throw new Error("boot: " + JSON.stringify(j));
  return redeem(j.invite);
}

/** Пригласить и принять: устройство `pult~a@b.c` или машина `@laptop`. */
export async function pass(fleet: string, byKey: string, addr: string, owner?: string): Promise<string> {
  const r = await ask(fleet, byKey, { type: "invite", addr, ...(owner ? { owner } : {}) });
  if (!r.ok) throw new Error("invite " + addr + ": " + r.error + " " + (r.why ?? ""));
  return redeem((r.result as { invite: string }).invite);
}

export type Conn = {
  ws: WebSocket;
  frames: Frame[];
  /** дождаться кадра по условию; найденный и всё до него снимается */
  next(pred: (f: Frame) => boolean, ms?: number): Promise<Frame>;
  closed: Promise<{ code: number; reason: string }>;
  send(f: Frame): void;
};

export async function connect(path: string, key: string, role: "page" | "host" | "keeper" | "watch", onAsk?: (f: Frame, c: Conn) => void): Promise<Conn> {
  const res = await SELF.fetch("https://p.test" + path, { headers: { Upgrade: "websocket" } });
  const ws = res.webSocket;
  if (!ws) throw new Error("нет соединения: " + res.status);
  ws.accept();
  const frames: Frame[] = [];
  const waiters: Array<() => void> = [];
  const c: Conn = {
    ws, frames,
    send: (f) => ws.send(JSON.stringify(f)),
    closed: new Promise((res2) => ws.addEventListener("close", (e) => res2({ code: e.code, reason: e.reason }))),
    next(pred, ms = 5000) {
      return new Promise<Frame>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("кадр не пришёл за " + ms + " мс; есть: " + frames.map((f) => f.type).join(","))), ms);
        const look = () => {
          const i = frames.findIndex(pred);
          if (i < 0) return false;
          const [f] = frames.splice(i, 1);
          frames.splice(0, i);
          clearTimeout(timer);
          resolve(f!);
          return true;
        };
        if (!look()) waiters.push(function again() {
          if (!look()) waiters.push(again);
        });
      });
    },
  };
  ws.addEventListener("message", (e) => {
    const f = JSON.parse(e.data as string) as Frame;
    if (onAsk && f.id && f.type !== "reply") onAsk(f, c);
    else frames.push(f);
    for (const w of waiters.splice(0)) w();
  });
  c.send({ type: "hello", proto: PROTO, key, role });
  // объект машины подтверждает вход; отказ — закрытие, его ждёт сам тест
  if (role !== "page") await Promise.race([c.next((f) => f.type === "hello.ok"), c.closed]);
  return c;
}

export const page = (fleet: string, key: string) => connect("/f/" + fleet, key, "page");
/** Host-подделка: на запрос отвечает `answer` (по умолчанию ok с эхом типа). */
export const host = (fleet: string, machine: string, key: string, answer?: (f: Frame) => Partial<Reply>) =>
  connect("/m/" + fleet + "/" + machine, key, "host", (f, c) => c.send({ type: "reply", id: f.id!, ok: true, result: { got: f.type, from: f.from }, spans: [{ part: "host", ms: 1 }], ...(answer ? answer(f) : {}) }));
export const watcher = (fleet: string, machine: string, key: string) => connect("/m/" + fleet + "/" + machine, key, "watch");

export const row = (callsign: string, extra: Partial<SessionRow> = {}): SessionRow => ({
  callsign, state: "idle", spec: { name: callsign.slice(0, callsign.indexOf("@")), cwd: "~/p" }, by: YURI, since: 1, ...extra,
});

/** Флот дизайна: Юра — админ с laptop и server; Аня с anya-pc в проекте «Сайт» с Юрой; Олег с oleg-mac в «Инфре» с Юрой. */
export async function trio() {
  const fleet = newFleet();
  const yuri = await boot(fleet);
  const anya = await pass(fleet, yuri, "pult" + ANYA);
  const oleg = await pass(fleet, yuri, "pult" + OLEG);
  for (const [id, members] of [["site", [YURI, ANYA]], ["infra", [YURI, OLEG]]] as const) {
    const r = await ask(fleet, yuri, { type: "project.set", project: id, name: id, members });
    if (!r.ok) throw new Error("project.set: " + r.error);
  }
  // админ Юра видел бы всё и без проектов: правило проверяется на Ане и Олеге
  const laptop = await pass(fleet, yuri, "@laptop");
  const server = await pass(fleet, yuri, "@server");
  const apc = await pass(fleet, anya, "@anya-pc");
  const omac = await pass(fleet, oleg, "@oleg-mac");
  return { fleet, yuri, anya, oleg, laptop, server, apc, omac };
}
