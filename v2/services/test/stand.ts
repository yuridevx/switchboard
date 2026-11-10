// Стенд служб: подделка платформы по её договору и короткий вызов входа. Каждый тест берёт свой флот — записи не пересекаются.
import { createExecutionContext, env as base, waitOnExecutionContext } from "cloudflare:test";
import { type Frame, machineOf, type MachineRow, newId, ok, type Reply, type SessionRow, type Who } from "@sb/protocol";
import type { Deps, Env, Platform } from "../src/env.ts";
import { serve } from "../src/index.ts";

export const env = base as unknown as Env;

let n = 0;
/** Имя флота, которого ещё не было. */
export const newFleet = () => `f${Date.now().toString(36)}${n++}`;

const secret = "s".repeat(20);

export type Stand = ReturnType<typeof stand>;

/** Флот с людьми и машинами: Юра — админ (laptop, server), Аня достаёт до своей anya-pc и машин Юры, Олег — только до своей oleg-mac. */
export function stand(fleet = newFleet(), opts: { env?: Partial<Env> } = {}) {
  const key = (kid: string) => `${fleet}:${kid}:${secret}`;
  const whos = new Map<string, Who>([
    [key("kyura1"), { kid: "kyura1", addr: "pult~yuri@example.com", person: "~yuri@example.com", admin: true, machines: ["laptop", "server", "anya-pc", "oleg-mac"] }],
    [key("kanya1"), { kid: "kanya1", addr: "pult~anya@example.com", person: "~anya@example.com", admin: false, machines: ["anya-pc", "laptop", "server"] }],
    [key("koleg1"), { kid: "koleg1", addr: "pult~oleg@example.com", person: "~oleg@example.com", admin: false, machines: ["oleg-mac"] }],
    [key("klaptop"), { kid: "klaptop", addr: "@laptop", person: "~yuri@example.com", admin: true, machines: ["laptop", "server", "anya-pc", "oleg-mac"] }],
    [key("kolegm"), { kid: "kolegm", addr: "@oleg-mac", person: "~oleg@example.com", admin: false, machines: ["oleg-mac"] }],
  ]);
  const seen = {
    delivered: [] as Frame[],
    broadcasts: [] as { frame: Frame; role: string }[],
    fleetCalls: [] as { who: Who | null; frame: Frame; fleet: string }[],
    fetched: [] as Request[],
    net: [] as { url: string; init?: RequestInit }[],
  };
  const state = {
    online: new Set<string>(),
    dead: new Set<string>(),
    /** строки сессий флота в картине */
    sessions: [] as SessionRow[],
    admins: ["~yuri@example.com"],
    /** ответ объекта флота на запрос; по умолчанию — эхо имени */
    fleetAnswer: null as ((frame: Frame, who: Who | null) => Reply) | null,
    /** ответ машины на доставленный кадр */
    answer: (f: Frame): Reply | null => (f.id ? { ...ok(f.id, { got: f.type }), spans: [{ part: "host", ms: 3 }] } : null),
    broadcastFails: false,
    /** ответ сети: по умолчанию 201 */
    net: (_url: string, _init?: RequestInit): Response | Promise<Response> => new Response(null, { status: 201 }),
  };
  const machines: MachineRow[] = [
    { name: "laptop", owner: "~yuri@example.com", online: true, since: 1 },
    { name: "server", owner: "~yuri@example.com", online: true, since: 1 },
    { name: "anya-pc", owner: "~anya@example.com", online: true, since: 1 },
    // ушла только что: порог «машина без связи» ещё не вышел — тест, которому нужен давний уход, ставит since сам
    { name: "oleg-mac", owner: "~oleg@example.com", online: false, since: Date.now() },
  ];
  const platform: Platform = {
    async who(k, as) {
      const w = whos.get(k);
      if (!w) return { error: "bad_key", why: "пропуска нет" };
      if (!as) return w;
      // машина говорит за свои сессии
      if (machineOf(as) !== machineOf(w.addr) || !w.addr.startsWith("@")) return { error: "forbidden", why: "чужой позывной" };
      return { ...w, addr: as };
    },
    async fleetCall(f, who, frame) {
      seen.fleetCalls.push({ fleet: f, who, frame });
      return state.fleetAnswer ? state.fleetAnswer(frame, who) : ok(frame.id!, { called: frame.type });
    },
    async deliver(_f, frame) {
      seen.delivered.push(frame);
      return state.answer(frame);
    },
    async broadcast(_f, frame, role) {
      if (state.broadcastFails) throw new Error("платформа упала");
      seen.broadcasts.push({ frame, role });
      return machines.length;
    },
    online: async (_f, person) => state.online.has(person),
    machines: async () => machines,
    sessions: async () => state.sessions,
    admins: async () => state.admins,
    alive: async (_f, kids) => kids.filter((k) => !state.dead.has(k)),
    async fetch(req) {
      seen.fetched.push(req);
      return new Response("platform");
    },
  };
  const deps: Deps = {
    platform,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      seen.net.push({ url, init });
      return state.net(url, init);
    }) as typeof fetch,
  };
  const e: Env = { ...env, ...opts.env };

  /** Сырой HTTP-запрос к Worker'у; работа «после ответа» дожидается. */
  async function http(path: string, init?: RequestInit): Promise<Response> {
    const exec = createExecutionContext();
    const res = await serve(new Request("https://fleet.test" + path, init), e, exec, deps);
    await waitOnExecutionContext(exec);
    return res;
  }

  /** Запрос договора через вход: as — кто (номер пропуска), sayAs — позывной сессии при пропуске машины. */
  async function ask(type: string, fields: Record<string, unknown> = {}, as: string | null = "kyura1", sayAs?: string): Promise<Reply> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (as) headers.authorization = "Bearer " + key(as);
    if (sayAs) headers["x-sb-as"] = sayAs;
    const res = await http("/call", { method: "POST", headers, body: JSON.stringify({ type, id: newId("r"), trace: newId("t"), ...fields }) });
    return (await res.json()) as Reply;
  }

  return { fleet, key, whos, seen, state, machines, platform, deps, env: e, http, ask };
}
