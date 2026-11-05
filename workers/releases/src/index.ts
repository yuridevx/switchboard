// Worker releases: POST кадра с пропуском (обёртка entrance) и кадр по привязке. Кадр → ответ; планы и журнал уходят по привязкам.
import { WorkerEntrypoint } from "cloudflare:workers";
import { accepts, fail, ok, type Frame } from "@switchboard/protocol";
import { entrance } from "@switchboard/gate";
import { CONTRACT } from "../contract.ts";
import { deploy } from "./deploy.ts";
import type { Env } from "./env.ts";
import { log, Refusal } from "./refusal.ts";
import { askPlan, fetchLink, list, setPlan, uploadLinks } from "./requests.ts";

const REQUESTS: Record<keyof typeof CONTRACT, (env: Env, f: Frame) => Promise<unknown>> = {
  "releases.plan": askPlan,
  "releases.list": list,
  "releases.upload": uploadLinks,
  "releases.deploy": deploy,
  "releases.set": setPlan,
  "releases.fetch": fetchLink,
};

async function serve(env: Env, f: Frame): Promise<Frame[]> {
  const from = f.from ?? "";
  // ответов «Выпуски» не ждут; отказ на ответ породил бы ответ на отказ
  if (f.type === "reply") {
    log({ kind: "note", ev: "reply", from, why: "releases ответов не ждёт" });
    return [];
  }
  try {
    const bad = accepts(f, CONTRACT);
    if (bad) throw new Refusal(bad.word, bad.why);
    if (!f.id) throw new Refusal("bad_frame", `${f.type} без id — ответить некому`);
    return [{ ...ok(f.id, await REQUESTS[f.type as keyof typeof CONTRACT](env, f)), to: from }];
  } catch (e) {
    if (!(e instanceof Refusal)) throw e;
    log({ kind: "refuse", ev: f.type, word: e.word, why: e.why, from, ...e.journal });
    return f.id ? [{ ...fail(f.id, e.word), why: e.why, to: from }] : [];
  }
}

export class Participant extends WorkerEntrypoint<Env> {
  fetch(req: Request): Promise<Response> {
    return entrance(req, this.env.GATE, (f) => this.frame(f));
  }

  frame(f: Frame): Promise<Frame[]> {
    return serve(this.env, f);
  }
}

export default Participant;
