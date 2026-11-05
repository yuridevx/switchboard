// Вход POST: дверь — метод, предел тела и разбор кадра; entrance — вход всех Worker'ов: пропуск, отправитель, ответ телом.
import { BAD_FRAME, fail, MAX_FRAME, parseFrame, TOO_LARGE, within, type Frame, type Reply } from "@switchboard/protocol";
import type { GateApi } from "../contract.ts";

const HEADERS = { "access-control-allow-origin": "*", "content-type": "application/json" };

/** Ответ кадром. Кадр без id ответа не ждёт: тела нет, 200 становится 204. */
export const answer = (id: string | undefined, reply: Reply, status = 200): Response =>
  id === undefined ? new Response(null, { status: status === 200 ? 204 : status, headers: HEADERS }) : new Response(JSON.stringify(reply), { status, headers: HEADERS });

/** Тело POST в кадр: не POST — 404, больше max байт — too_large, не кадр — bad_frame. */
export async function door(req: Request, max: number, serve: (f: Frame) => Promise<Response>): Promise<Response> {
  if (req.method !== "POST") return new Response(null, { status: 404 });
  const text = await req.text();
  if (new TextEncoder().encode(text).length > max) return answer("", fail("", TOO_LARGE), 413);
  const f = parseFrame(text);
  return f ? serve(f) : answer("", fail("", BAD_FRAME), 400);
}

/** Запрос к Worker'у: кадр с key → gate.verify → frame с from и fromKid → reply телом. Кадры другим не уходят: их доставляет только relay. */
export function entrance(req: Request, gate: Pick<GateApi, "verify">, frame: (f: Frame) => Frame[] | Promise<Frame[]>, log: (line: string) => void = console.log): Promise<Response> {
  return door(req, MAX_FRAME, async ({ key, from: _from, fromKid: _fromKid, ...f }) => {
    const { id, type } = f;
    const refuse = (word: string, status?: number) => answer(id, fail(id ?? "", word), status);
    let who;
    try {
      who = await within(gate.verify(String(key ?? "")), "gate не ответил на verify");
    } catch (e) {
      log(`gate_unavailable ${type} · ${e}`);
      return refuse("gate_unavailable", 503);
    }
    if ("error" in who) {
      log(`${who.error} ${type}`);
      return refuse(who.error);
    }
    const from = who.addr;
    let out;
    try {
      out = await frame({ ...f, from, fromKid: who.kid });
    } catch (e) {
      log(`failed ${type} от ${from} · ${e}`);
      return refuse("failed", 500);
    }
    const reply = out.find((r) => r.type === "reply" && r.id === id && r.to === from);
    for (const r of out) if (r !== reply) log(`relay_only ${r.type} → ${JSON.stringify(r.to)} · ответ на ${type} от ${from}: такие кадры доставляет только relay`);
    return reply ? answer(id, reply as Reply) : refuse("no_reply");
  });
}
