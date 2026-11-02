// Worker relay — вход без состояния: wss /m/<машина> → объект этой машины; wss / — объект перехода home.
// POST keys.revoke — отзыв пропуска: отметка у gate, затем close на объектах всех машин флота.
// Привязка Relay.deliver — кадр Worker'а своей машине (план keeper'у от «Выпусков»).
import { WorkerEntrypoint } from "cloudflare:workers";
import { accepts, fail, machineOf, ok, parseFrame, type Frame, type Reply } from "@switchboard/protocol";
import { CONTRACT } from "../contract.ts";
import { FLEET, Fleet, call, machineObject, type Env } from "./fleet.ts";

export { Fleet };

const log = (line: string) => console.log(line);
const MACHINE = /^\/m\/([A-Za-z0-9_-]+)$/;
/** Предел тела POST: кадр отзыва — несколько полей. */
const MAX_BODY = 16 * 1024;
// страница шлёт простой POST без предзапроса — ответ читается с любого адреса
const CORS = { "access-control-allow-origin": "*" };

const stub = (env: Env, name: string) => env.FLEET.get(env.FLEET.idFromName(name));

/** keys.revoke {key, kid}: отметка у gate, close на объекте каждой машины из списка gate и на объекте перехода. */
async function revoke(env: Env, text: string): Promise<Reply> {
  const f = parseFrame(text);
  if (!f || !f.id) return fail(f?.id ?? "", "bad_frame");
  const bad = accepts(f, CONTRACT);
  if (bad) return fail(f.id, bad.word);
  const who = await call(env.GATE.verify(String(f.key ?? "")));
  if ("error" in who) return fail(f.id, who.error);
  if (typeof f.kid !== "string" || !f.kid) return fail(f.id, "bad_request");
  const r = await call(env.GATE.revoke(f.kid));
  if ("error" in r) {
    log(`unknown_key ${f.kid} · отзыв от ${who.addr}`);
    return fail(f.id, r.error);
  }
  const machines = (await call(env.GATE.list("host"))).map((p) => p.name);
  const closed = (await Promise.all([FLEET, ...machines.map(machineObject)].map((n) => stub(env, n).close(f.kid as string)))).reduce((a, b) => a + b, 0);
  log(`revoke ${f.kid} ${r.addr} · отозвал ${who.addr} · закрыто соединений ${closed} на ${machines.length} машинах`);
  return ok(f.id, { addr: r.addr, closed });
}

export class Relay extends WorkerEntrypoint<Env> {
  /** Кадр Worker'а по привязке: from ставит вызывающий; to — машина, сессия или часть машины. Ответ — сколько получателей. */
  async deliver(f: Frame): Promise<number> {
    const m = typeof f.to === "string" ? machineOf(f.to) : null;
    if (!m) return 0;
    return stub(this.env, machineObject(m)).deliver(f);
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const path = new URL(req.url).pathname;
    if (req.method === "POST" && path === "/") {
      const text = await req.text();
      if (text.length > MAX_BODY) return Response.json(fail("", "too_large"), { status: 413, headers: CORS });
      try {
        return Response.json(await revoke(env, text), { headers: CORS });
      } catch (e) {
        log(`gate_unavailable keys.revoke · ${e}`);
        return Response.json(fail(parseFrame(text)?.id ?? "", "gate_unavailable"), { status: 503, headers: CORS });
      }
    }
    if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("switchboard relay: wss /m/<машина> или POST keys.revoke\n", { status: 426 });
    }
    const m = MACHINE.exec(path);
    if (!m && path !== "/") return new Response("switchboard relay: нет такого пути\n", { status: 404 });
    return stub(env, m ? machineObject(m[1]) : FLEET).fetch(req);
  },
} satisfies ExportedHandler<Env>;
