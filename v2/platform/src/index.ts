// Вход платформы: адреса соединений, заведение флота и вход привязки для служб.
import { WorkerEntrypoint } from "cloudflare:workers";
import { fail, type Frame, keeperAddr, kindOf, machineAddr, machineOf, type MachineRow, parsePass, type Reply, type Who } from "@sb/protocol";
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

/** Методы платформы для служб. Отдельной функцией — чтобы вызывать и из тестов. */
export function platformApi(env: Env): PlatformApi {
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
      // ответ несёт произвольный result: типы RPC его не выводят
      const { reply, drop } = (await fleetStub(env, name).call(name, who, frame)) as unknown as { reply: Reply; drop?: Drop };
      if (drop) await dropAll(env, name, drop, before);
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
    machines: (fleet): Promise<MachineRow[]> => fleetStub(env, fleet).machines(),
  };
}

/** Вход привязки служб. */
export class Platform extends WorkerEntrypoint<Env> implements PlatformApi {
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
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
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
  },
} satisfies ExportedHandler<Env>;
