// Worker gate: без состояния, пропуска — в базе D1 gate.
// Привязка (вход Gate): verify, revoke, revoked, list. Адрес: POST keys.invite, keys.list (с пропуском), gate.redeem (без пропуска).
import { WorkerEntrypoint } from "cloudflare:workers";
import { accepts, fail, ok, parseFrame, type Reply } from "@switchboard/protocol";
import { CONTRACT, type GateApi, type Pass, type VerifyResult } from "../contract.ts";
import { invite, list, redeem, revoke, revoked, verify, type Env } from "./pass.ts";

export type { Env };

const log = (line: string) => console.log(line);

export class Gate extends WorkerEntrypoint<Env> implements GateApi {
  verify(key: string): Promise<VerifyResult> {
    return verify(this.env, key, log);
  }

  async revoke(kid: string): Promise<{ addr: string } | { error: "unknown_key" }> {
    const r = await revoke(this.env, kid);
    log("error" in r ? `unknown_key ${kid} · отзыв` : `revoked ${kid} ${r.addr} · отметка`);
    return r;
  }

  revoked(ids: string[]): Promise<string[]> {
    return revoked(this.env, ids);
  }

  async list(role?: "host" | "client"): Promise<Pass[]> {
    const r = await list(this.env, { role });
    if ("error" in r) throw new Error(r.why);
    return r.passes;
  }
}

/** Предел тела запроса: кадры gate — несколько полей. */
const MAX_BODY = 16 * 1024;
// страница шлёт простой POST без предзапроса — ответ читается с любого адреса
const CORS = { "access-control-allow-origin": "*" };

function reply(r: Reply, status = 200): Response {
  return Response.json(r, { status, headers: CORS });
}

async function handle(env: Env, text: string): Promise<Reply> {
  const f = parseFrame(text);
  if (!f || !f.id) return fail(f?.id ?? "", "bad_frame");
  const bad = accepts(f, CONTRACT);
  if (bad) {
    log(`${bad.word} ${bad.why}`);
    return fail(f.id, bad.word);
  }
  if (f.type === "gate.redeem") {
    const r = await redeem(env, f);
    if ("error" in r) {
      log(`${r.error} ${r.why}`);
      return fail(f.id, r.error);
    }
    log(`redeem ${r.key.split(".").slice(0, 3).join(".")} · принят`);
    return ok(f.id, r);
  }
  const who = await verify(env, f.key, log);
  if ("error" in who) return fail(f.id, who.error);
  const r = f.type === "keys.invite" ? await invite(env, who, f) : await list(env, f);
  if ("error" in r) {
    log(`${r.error} ${f.type} от ${who.addr} · ${r.why}`);
    return fail(f.id, r.error);
  }
  if ("invite" in r) log(`invite ${r.kid} ${r.addr} · выдал ${who.addr}`);
  return ok(f.id, r);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method !== "POST") return new Response(null, { status: 404 });
    const text = await req.text();
    if (text.length > MAX_BODY) return reply(fail("", "too_large"), 413);
    try {
      return reply(await handle(env, text));
    } catch (e) {
      log(`gate_unavailable ${(e as Error).message}`);
      return reply(fail(parseFrame(text)?.id ?? "", "gate_unavailable"), 503);
    }
  },
};
