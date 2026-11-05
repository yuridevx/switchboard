// Worker gate без состояния, пропуска — в базе D1. Две двери: вход Gate по привязке и POST кадра по адресу.
import { WorkerEntrypoint } from "cloudflare:workers";
import { accepts, fail, ok, parseFrame, type Frame, type Reply } from "@switchboard/protocol";
import { CONTRACT, type GateApi, type Pass, type VerifyResult } from "../contract.ts";
import { invite, list, redeem, verify, type Log, type Refusal } from "./gate.ts";
import { deletePass, listPasses, liveKids, type Env } from "./passes.ts";

export type { Env };

const log: Log = (line) => console.log(line);
/** Номер в отзыве и сверке — kid или role.name.kid. */
const kidOf = (id: string) => id.slice(id.lastIndexOf(".") + 1);

export class Gate extends WorkerEntrypoint<Env> implements GateApi {
  verify(key: string): Promise<VerifyResult> {
    return verify(this.env.DB, key, log);
  }

  async revoke(kid: string): Promise<{ addr: string } | { error: "unknown_key" }> {
    const row = await deletePass(this.env.DB, kid);
    if (!row) {
      log(`unknown_key ${kid} · отзыв`);
      return { error: "unknown_key" };
    }
    log(`revoked ${kid} ${row.addr} · строка удалена`);
    return { addr: row.addr };
  }

  async revoked(ids: string[]): Promise<string[]> {
    if (!ids.length) return [];
    const live = await liveKids(this.env.DB, ids.map(kidOf));
    return ids.filter((id) => !live.has(kidOf(id)));
  }

  list(role?: "host" | "client"): Promise<Pass[]> {
    return listPasses(this.env.DB, role);
  }
}

/** Предел тела запроса: кадры gate — несколько полей. */
const MAX_BODY = 16 * 1024;
// страница шлёт простой POST без предзапроса — ответ читается с любого адреса
const CORS = { "access-control-allow-origin": "*" };
const respond = (r: Reply, status = 200) => Response.json(r, { status, headers: CORS });

function refused(f: Frame & { id: string }, r: Refusal, who?: string): Reply {
  log(`${r.error} ${who ? `${f.type} от ${who} · ` : ""}${r.why}`);
  return fail(f.id, r.error);
}

async function redeemFrame(db: D1Database, f: Frame & { id: string }): Promise<Reply> {
  const r = await redeem(db, f);
  if ("error" in r) return refused(f, r);
  log(`redeem ${r.key.slice(0, r.key.lastIndexOf("."))} · принят`);
  return ok(f.id, r);
}

/** keys.invite и keys.list: только с пропуском. */
async function keysFrame(db: D1Database, f: Frame & { id: string }): Promise<Reply> {
  const who = await verify(db, f.key, log);
  if ("error" in who) return fail(f.id, who.error);
  if (f.type === "keys.list") {
    const r = await list(db, f);
    return "error" in r ? refused(f, r, who.addr) : ok(f.id, { ...r, you: who.addr });
  }
  const r = await invite(db, who, f);
  if ("error" in r) return refused(f, r, who.addr);
  log(`invite ${r.kid} ${r.addr} · выдал ${who.addr}`);
  return ok(f.id, r);
}

async function handle(db: D1Database, text: string): Promise<Reply> {
  const f = parseFrame(text);
  if (!f?.id) return fail(f?.id ?? "", "bad_frame");
  const request = f as Frame & { id: string };
  const bad = accepts(f, CONTRACT);
  if (bad) {
    log(`${bad.word} ${bad.why}`);
    return fail(request.id, bad.word);
  }
  return f.type === "gate.redeem" ? redeemFrame(db, request) : keysFrame(db, request);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method !== "POST") return new Response(null, { status: 404 });
    const text = await req.text();
    if (text.length > MAX_BODY) return respond(fail("", "too_large"), 413);
    try {
      return respond(await handle(env.DB, text));
    } catch (e) {
      log(`gate_unavailable ${(e as Error).message}`);
      return respond(fail(parseFrame(text)?.id ?? "", "gate_unavailable"), 503);
    }
  },
};
