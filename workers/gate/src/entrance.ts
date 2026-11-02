// Вход Worker'а по адресу: POST кадра с пропуском → gate.verify → frame(кадр с from и номером пропуска) → ответ телом.
// Одна функция для всех Worker'ов флота и Worker'ов из чужих репо: своего кода входа у модуля нет.
import { MAX_FRAME, fail, parseFrame, type Frame, type Reply } from "@switchboard/protocol";
import type { GateApi } from "../contract.ts";

// страница шлёт простой POST без предзапроса — ответ читается с любого адреса
const CORS = { "access-control-allow-origin": "*" };

function answer(r: Reply | null, status = 200): Response {
  return r ? Response.json(r, { status, headers: CORS }) : new Response(null, { status: status === 200 ? 204 : status, headers: CORS });
}

/**
 * Вход Worker'а. Отправитель — адрес пропуска; from из тела не берётся, key до frame не доходит, номер пропуска — поле kid.
 * Ответ на кадр с id — reply телом; кадр без id — 204 без тела. Кадры другим адресатам из frame не уходят:
 * их доставляет только relay — строка relay_only в журнале.
 * Слова отказа: bad_frame, too_large, bad_key, revoked (от gate), gate_unavailable, failed — frame бросил.
 */
export async function entrance(req: Request, gate: GateApi, frame: (f: Frame) => Frame[] | Promise<Frame[]>, log: (line: string) => void = (l) => console.log(l)): Promise<Response> {
  if (req.method !== "POST") return new Response(null, { status: 404 });
  const text = await req.text();
  if (text.length > MAX_FRAME) return answer(fail("", "too_large"), 413);
  const f = parseFrame(text);
  if (!f) return answer(fail("", "bad_frame"), 400);
  const id = f.id;
  const refuse = (word: string, status: number) => (id ? answer(fail(id, word), status) : answer(null, status));
  const { key, from: _from, kid: _kid, ...rest } = f;
  let who;
  try {
    who = await gate.verify(String(key ?? ""));
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
    out = await frame({ ...rest, type: f.type, from: who.addr, kid: who.kid });
  } catch (e) {
    log(`failed ${f.type} от ${who.addr} · ${e}`);
    return refuse("failed", 500);
  }
  let reply: Reply | null = null;
  for (const o of out ?? []) {
    if (id && o.type === "reply" && o.id === id && o.to === who.addr) reply = o as Reply;
    else log(`relay_only ${o.type} → ${JSON.stringify(o.to)} · ответ на ${f.type} от ${who.addr}: такие кадры доставляет только relay`);
  }
  if (!id) return answer(null);
  return answer(reply ?? fail(id, "no_reply"));
}
