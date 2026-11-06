// gate: привязка Gate внутри аккаунта и POST по адресу gate; пропуска — база D1 (passes.ts).
import { WorkerEntrypoint } from "cloudflare:workers";
import { accepts, BAD_FRAME, fail, ok, type Frame } from "@switchboard/protocol";
import { CONTRACT, type GateApi, type Pass } from "../contract.ts";
import { answer, door, refuseFrame } from "./entrance.ts";
import { invite, list, redeem, revoke, revoked, verify } from "./passes.ts";

type Env = { DB: D1Database };

/** Предел тела: дверь открыта без пропуска, запросы её — короткие поля. */
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
  redeem(code: string) {
    return redeem(this.env.DB, code);
  }
}

/** Значение запроса или отказ словом: поле error. */
async function work(f: Frame, db: D1Database): Promise<object> {
  if (f.type === "gate.redeem") return redeem(db, f.invite);
  const who = await verify(db, f.key);
  if ("error" in who) return who;
  if (f.type === "keys.invite") return invite(db, f, who.addr);
  const role = f.role as Pass["role"] | undefined;
  if (![undefined, "host", "client"].includes(role)) {
    console.log(`bad_request keys.list от ${who.addr} · role — host или client`);
    return { error: "bad_request" };
  }
  return { passes: await list(db, role), you: who.addr };
}

async function serve(f: Frame, db: D1Database): Promise<Response> {
  const { id } = f;
  if (!id) return refuseFrame(BAD_FRAME, 400);
  const no = accepts(f, CONTRACT);
  if (no) {
    console.log(`${no.word} ${no.why}`);
    return answer(id, fail(id, no.word));
  }
  try {
    const r = await work(f, db);
    return answer(id, "error" in r ? fail(id, r.error as string) : ok(id, r));
  } catch (e) {
    console.log(`gate_unavailable ${(e as Error).message}`);
    return answer(id, fail(id, "gate_unavailable"), 503);
  }
}

export default { fetch: (req: Request, env: Env) => door(req, MAX_BODY, (f) => serve(f, env.DB)) };
