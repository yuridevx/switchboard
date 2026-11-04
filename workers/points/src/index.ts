// Вход Worker'а точек: POST кадра с пропуском, кадр по привязке внутри аккаунта и уборка раз в сутки по расписанию.
import { WorkerEntrypoint } from "cloudflare:workers";
import { entrance } from "@switchboard/gate";
import { accepts, fail, machineOf, ok, within, type Frame } from "@switchboard/protocol";
import type { LedgerAdd } from "@switchboard/ledger";
import { CONTRACT } from "../contract.ts";
import type { Env } from "./env.ts";
import { log } from "./log.ts";
import { Refused, serve, sweep } from "./registry.ts";

/** Строка журнала флота; журнал не ответил — строка здесь. */
async function toLedger(env: Env, line: LedgerAdd): Promise<void> {
  try {
    await within(env.LEDGER.frame({ ...(line as unknown as Frame), from: ".points" }), "журнал не ответил");
  } catch (err) {
    log({ kind: "refuse", ev: "ledger.add", word: "offline", why: `${line.ev}: ${err}` });
  }
}

export class Participant extends WorkerEntrypoint<Env> {
  fetch(req: Request): Promise<Response> {
    return entrance(req, this.env.GATE, (f) => this.frame(f));
  }

  async frame(f: Frame): Promise<Frame[]> {
    const from = f.from ?? "";
    if (f.type === "reply") {
      log({ kind: "note", ev: "reply", from, why: "points ответов не ждёт" });
      return [];
    }
    const refuse = (word: string, why: string, fields: Record<string, unknown> = {}): Frame[] => {
      log({ kind: "refuse", ev: f.type, word, why, from, sid: typeof f.sid === "string" ? f.sid : undefined });
      return f.id ? [{ ...fail(f.id, word), ...fields, to: from }] : [];
    };
    const bad = accepts(f, CONTRACT);
    if (bad) return refuse(bad.word, bad.why);
    if (!f.id) return refuse("bad_frame", `${f.type} без id — ответить некому`);
    try {
      const { result, line } = await serve(this.env, f, from ? machineOf(from) : null);
      if (line) await toLedger(this.env, line);
      return [{ ...ok(f.id, result), to: from }];
    } catch (e) {
      if (e instanceof Refused) return refuse(e.word, e.message, e.fields);
      throw e;
    }
  }

  scheduled(): Promise<void> {
    return sweep(this.env);
  }
}

export default Participant;
