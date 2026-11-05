// Worker gate, две двери: привязка Gate внутри аккаунта и POST кадра по адресу.
import { WorkerEntrypoint } from "cloudflare:workers";
import { BAD_FRAME, TOO_LARGE, accepts, fail, ok, parseFrame, type Frame, type Reply } from "@switchboard/protocol";
import { CONTRACT, type GateApi, type Pass } from "../contract.ts";
import { json } from "./entrance.ts";
import { invite, list, redeem, revoke, revoked, verify } from "./passes.ts";

type Env = { DB: D1Database };

const MAX_BODY = 16 * 1024;

export class Gate extends WorkerEntrypoint<Env> implements GateApi {
  verify(key: string) {
    return verify(this.env.DB, key);
  }
  revoke(kid: string) {
    return revoke(this.env.DB, kid);
  }
  revoked(ids: string[]) {
    return revoked(this.env.DB, ids);
  }
  list(role?: Pass["role"]) {
    return list(this.env.DB, role);
  }
}

async function serve(db: D1Database, f: Frame & { id: string }): Promise<Reply> {
  const refused = accepts(f, CONTRACT);
  if (refused) {
    console.log(`${refused.word} ${refused.why}`);
    return fail(f.id, refused.word);
  }
  if (f.type === "gate.redeem") {
    const key = await redeem(db, f.invite);
    return key ? ok(f.id, { key }) : fail(f.id, "bad_invite");
  }
  const who = await verify(db, f.key);
  if ("error" in who) return fail(f.id, who.error);
  const refuse = (word: string, why: string) => {
    console.log(`${word} ${f.type} от ${who.addr} · ${why}`);
    return fail(f.id, word);
  };
  if (f.type === "keys.invite") {
    const r = await invite(db, who.addr, f);
    return "error" in r ? refuse(r.error, r.why) : ok(f.id, r);
  }
  const role = f.role as Pass["role"] | undefined;
  if (role !== undefined && role !== "host" && role !== "client") return refuse("bad_request", "role — host или client");
  return ok(f.id, { passes: await list(db, role), you: who.addr });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method !== "POST") return new Response(null, { status: 404 });
    const text = await req.text();
    if (text.length > MAX_BODY) return json(fail("", TOO_LARGE), 413);
    const f = parseFrame(text);
    if (!f?.id) return json(fail("", BAD_FRAME));
    try {
      return json(await serve(env.DB, f as Frame & { id: string }));
    } catch (e) {
      console.log(`gate_unavailable ${(e as Error).message}`);
      return json(fail(f.id, "gate_unavailable"), 503);
    }
  },
};
