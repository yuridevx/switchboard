// Прямой вход Worker-модуля: POST кадра с пропуском → gate.verify → кадр с from и fromKid → reply телом.
import { BAD_FRAME, TOO_LARGE, fail, oversize, parseFrame, within, type Frame, type Reply } from "@switchboard/protocol";
import type { GateApi, VerifyResult } from "../contract.ts";

const CORS = { "access-control-allow-origin": "*" };

/** Ответ кадром: страница шлёт простой POST без предзапроса, ответ читается с любого адреса. */
export const json = (body: Frame | Reply, status = 200): Response => Response.json(body, { status, headers: CORS });

/** handle возвращает кадры отправителю: reply с его id и адресом идёт телом ответа. Кадры другим этот вход не доставляет: их доставляет только relay. */
export async function entrance(req: Request, gate: Pick<GateApi, "verify">, handle: (f: Frame) => Frame[] | Promise<Frame[]>, log: (line: string) => void = console.log): Promise<Response> {
  if (req.method !== "POST") return new Response(null, { status: 404 });
  const text = await req.text();
  if (oversize(text) !== null) return json(fail("", TOO_LARGE), 413);
  const parsed = parseFrame(text);
  if (!parsed) return json(fail("", BAD_FRAME), 400);
  const { key, from: _from, fromKid: _fromKid, ...f } = parsed;
  // на кадр без id ответа не ждут: только код
  const refuse = (word: string, status: number) => (f.id ? json(fail(f.id, word), status) : new Response(null, { status: status === 200 ? 204 : status, headers: CORS }));

  let who: VerifyResult;
  try {
    who = await within(gate.verify(typeof key === "string" ? key : ""), "gate не ответил на verify");
  } catch (e) {
    log(`gate_unavailable ${f.type} · ${e}`);
    return refuse("gate_unavailable", 503);
  }
  if ("error" in who) {
    log(`${who.error} ${f.type}`);
    return refuse(who.error, 200);
  }

  let out: Frame[];
  try {
    out = await handle({ ...f, from: who.addr, fromKid: who.kid } as Frame);
  } catch (e) {
    log(`failed ${f.type} от ${who.addr} · ${e}`);
    return refuse("failed", 500);
  }
  let reply: Frame | undefined;
  for (const o of out) {
    if (f.id && o.type === "reply" && o.id === f.id && o.to === who.addr) reply = o;
    else log(`relay_only ${o.type} → ${JSON.stringify(o.to)} · ответ на ${f.type} от ${who.addr}: такие кадры доставляет только relay`);
  }
  if (reply) return json(reply);
  return refuse("no_reply", 200);
}
