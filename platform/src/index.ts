// Вход платформы: адреса соединений, заведение флота и вход привязки для служб.
import { WorkerEntrypoint } from "cloudflare:workers";
import { fail, type Frame, keeperAddr, kindOf, machineAddr, machineOf, type MachineRow, parsePass, READ_MS, type Reply, type SessionRow, type Who, within } from "@sb/protocol";
import { type PlatformApi, ROUTES } from "./contract.ts";
import { type Drop, type Env, fleetStub, log, machineStub } from "./env.ts";

export { FleetObject } from "./fleet.ts";
export { MachineObject } from "./machine.ts";

const NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/i;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Отключить у объектов машин тех, кого отозвали или у кого сменился доступ. */
async function dropAll(env: Env, fleet: string, d: Drop, extra: string[] = []): Promise<void> {
  const names = new Set([...(await fleetStub(env, fleet).machines()).map((m) => m.name), ...extra]);
  await Promise.all([...names].map((m) => machineStub(env, fleet, m).drop(d)));
}

/** Описание клиента OAuth по его адресу (client_id — URL): адрес возврата обязан быть в redirect_uris. Loopback — с любым портом (RFC 8252).
 *  Ответ — имя и адрес клиента для экрана согласия или причина отказа словами. */
export async function clientDoc(f: typeof fetch, client: string, back: string): Promise<{ name?: string; uri?: string } | { why: string }> {
  let want: URL;
  try {
    if (new URL(client).protocol !== "https:") return { why: "адрес описания клиента — не https" };
    want = new URL(back);
  } catch {
    return { why: "client и back — адреса" };
  }
  let doc: { client_id?: unknown; redirect_uris?: unknown; client_name?: unknown; client_uri?: unknown };
  try {
    const res = await within(f(client, { headers: { accept: "application/json" } }), READ_MS, "описание клиента " + client + " молчит");
    if (!res.ok) return { why: "описание клиента " + client + ": " + res.status };
    doc = await res.json();
  } catch (e) {
    return { why: "описание клиента " + client + ": " + (e instanceof Error ? e.message : String(e)) };
  }
  if (!doc || doc.client_id !== client) return { why: "описание клиента " + client + ": client_id не совпадает с адресом" };
  const loop = (u: URL) => ["127.0.0.1", "[::1]", "localhost"].includes(u.hostname);
  const same = (u: string) => {
    try {
      const x = new URL(u);
      return loop(x) && loop(want) ? x.protocol === want.protocol && x.hostname === want.hostname && x.pathname === want.pathname : x.href === want.href;
    } catch {
      return false;
    }
  };
  if (!Array.isArray(doc.redirect_uris) || !doc.redirect_uris.some((u) => typeof u === "string" && same(u))) return { why: back + " нет в redirect_uris клиента " + client };
  return { ...(typeof doc.client_name === "string" ? { name: doc.client_name } : {}), ...(typeof doc.client_uri === "string" ? { uri: doc.client_uri } : {}) };
}

/** Методы платформы для служб. Отдельной функцией — чтобы вызывать и из тестов; net — сеть (в тестах подменяется). */
export function platformApi(env: Env, net: typeof fetch = fetch): PlatformApi {
  return {
    async who(key, as) {
      const p = parsePass(key);
      if (!p) return { error: "bad_key", why: "пропуск не того вида" };
      return fleetStub(env, p.fleet).who(key, as);
    },
    async fleetCall(fleet, who: Who | null, frame: Frame): Promise<Reply> {
      const t0 = Date.now();
      // у приёма приглашения флот — из самого приглашения
      const name = fleet || parsePass(frame.invite)?.fleet || "";
      if (!NAME.test(name)) return fail(frame.id ?? "", "bad_input", "флот не назван");
      const before = frame.type === "revoke" || frame.type === "people.remove" ? (await fleetStub(env, name).machines()).map((m) => m.name) : [];
      // согласие OAuth: описание клиента сверяет вход — объект флота в сеть не ходит
      let doc: { name?: string; uri?: string } | null = null;
      if (frame.type === "consent") {
        const got = await clientDoc(net, String(frame.client ?? ""), String(frame.back ?? ""));
        if ("why" in got) {
          log.warn("согласие отказано", { fleet: name, type: frame.type, trace: frame.trace, from: who?.addr, word: "bad_client", why: got.why });
          return { ...fail(frame.id ?? "", "bad_client", got.why), trace: frame.trace, spans: [{ part: "platform", ms: Date.now() - t0 }] };
        }
        doc = got;
      }
      // ответ несёт произвольный result: типы RPC его не выводят
      const { reply, drop } = (await fleetStub(env, name).call(name, who, frame)) as unknown as { reply: Reply; drop?: Drop };
      if (drop) await dropAll(env, name, drop, before);
      if (doc && reply.ok) (reply.result as { client: object }).client = doc;
      const ms = Date.now() - t0;
      log.info("запрос объекту флота", { fleet: name, type: frame.type, trace: frame.trace, from: who?.addr, ms, ok: reply.ok, ...(reply.ok ? {} : { word: reply.error, why: reply.why }) });
      return { ...reply, trace: frame.trace, spans: [{ part: "platform", ms }] };
    },
    async deliver(fleet, frame) {
      const to = typeof frame.to === "string" ? frame.to : "";
      const machine = machineOf(to);
      if (!machine) return frame.id ? fail(frame.id, "bad_input", "адресат — сессия, машина или keeper") : null;
      return machineStub(env, fleet, machine).deliver(fleet, machine, frame);
    },
    async broadcast(fleet, frame, role) {
      const machines = await fleetStub(env, fleet).machines();
      const { id: _id, ...rest } = frame;
      const sent = await Promise.all(machines.map((m) => machineStub(env, fleet, m.name).push({ ...rest, to: role === "keeper" ? keeperAddr(m.name) : machineAddr(m.name) }, role)));
      const n = sent.filter(Boolean).length;
      log.info("рассылка машинам", { fleet, type: frame.type, trace: frame.trace, role, n, of: machines.length });
      return n;
    },
    online: (fleet, person) => fleetStub(env, fleet).online(person),
    alive: (fleet, kids) => fleetStub(env, fleet).alive(kids),
    fetch: (request) => route(request, env),
    machines: (fleet): Promise<MachineRow[]> => fleetStub(env, fleet).machines(),
    sessions: (fleet): Promise<SessionRow[]> => fleetStub(env, fleet).sessions() as Promise<SessionRow[]>,
    admins: (fleet) => fleetStub(env, fleet).admins(),
  };
}

/** Вход привязки служб. */
export class Platform extends WorkerEntrypoint<Env> implements PlatformApi {
  /** Проход соединений /f и /m от служб: тот же разбор адресов, что у входа Worker'а. */
  override fetch(request: Request) {
    return route(request, this.env);
  }
  alive(fleet: string, kids: string[]) {
    return platformApi(this.env).alive(fleet, kids);
  }
  who(key: string, as?: string) {
    return platformApi(this.env).who(key, as);
  }
  fleetCall(fleet: string, who: Who | null, frame: Frame) {
    return platformApi(this.env).fleetCall(fleet, who, frame);
  }
  deliver(fleet: string, frame: Frame) {
    return platformApi(this.env).deliver(fleet, frame);
  }
  broadcast(fleet: string, frame: Frame, role: "host" | "keeper") {
    return platformApi(this.env).broadcast(fleet, frame, role);
  }
  online(fleet: string, person: string) {
    return platformApi(this.env).online(fleet, person);
  }
  machines(fleet: string) {
    return platformApi(this.env).machines(fleet);
  }
  sessions(fleet: string) {
    return platformApi(this.env).sessions(fleet);
  }
  admins(fleet: string) {
    return platformApi(this.env).admins(fleet);
  }
}

async function route(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);
    if (url.pathname === ROUTES.health) return json({ ok: true, part: "platform" });
    if (url.pathname.startsWith(ROUTES.fleet) && parts.length === 2 && NAME.test(parts[1]!)) return fleetStub(env, parts[1]!).fetch(request);
    if (url.pathname.startsWith(ROUTES.machine) && parts.length === 3 && NAME.test(parts[1]!) && NAME.test(parts[2]!)) return machineStub(env, parts[1]!, parts[2]!).fetch(request);
    if (url.pathname === ROUTES.boot && request.method === "POST") {
      if (!env.BOOT || request.headers.get("authorization") !== "Bearer " + env.BOOT) return json({ ok: false, error: "forbidden" }, 403);
      const body = (await request.json().catch(() => null)) as { fleet?: unknown; person?: unknown } | null;
      if (!body || typeof body.fleet !== "string" || !NAME.test(body.fleet) || kindOf(body.person) !== "person") return json({ ok: false, error: "bad_input", why: "тело { fleet, person: ~a@b.c }" }, 400);
      const r = await fleetStub(env, body.fleet).boot(body.fleet, body.person as string);
      if ("error" in r) return json({ ok: false, ...r }, 409);
      log.info("флот заведён", { fleet: body.fleet, from: body.person as string });
      return json({ ok: true, ...r });
    }
    return json({ ok: false, error: "not_found" }, 404);
}

export default { fetch: route } satisfies ExportedHandler<Env>;
