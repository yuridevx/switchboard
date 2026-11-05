// Вход Worker'а по адресу: POST кадра с пропуском → gate.verify → frame(кадр с from и fromKid) → ответ телом.
// Одна функция для всех Worker'ов флота и Worker'ов из чужих репо: своего кода входа у модуля нет.
import { MAX_FRAME, fail, parseFrame, within, type Frame, type Reply } from "@switchboard/protocol";
import type { GateApi } from "../contract.ts";

// страница шлёт простой POST без предзапроса — ответ читается с любого адреса
const CORS = { "access-control-allow-origin": "*" };
const body = (r: Reply, status = 200) => Response.json(r, { status, headers: CORS });
const noBody = (status: number) => new Response(null, { status, headers: CORS });

/**
 * Вход Worker'а. Отправитель — адрес пропуска; from и fromKid из тела не берутся, key до frame не доходит, номер пропуска
 * отправителя — поле fromKid (kid остаётся полем запроса: keys.revoke {kid} — номер отзываемого пропуска).
 * Ответ на кадр с id — reply телом; кадр без id — 204 без тела. Кадры другим адресатам из frame не уходят:
 * их доставляет только relay — строка relay_only в журнале.
 * Слова отказа: bad_frame, too_large, bad_key (от gate), gate_unavailable, failed — frame бросил.
 */
export async function entrance(req: Request, gate: GateApi, frame: (f: Frame) => Frame[] | Promise<Frame[]>, log: (line: string) => void = (l) => console.log(l)): Promise<Response> {
  if (req.method !== "POST") return new Response(null, { status: 404 });
  const text = await req.text();
  if (text.length > MAX_FRAME) return body(fail("", "too_large"), 413);
  const parsed = parseFrame(text);
  if (!parsed) return body(fail("", "bad_frame"), 400);
  const { key, from: _from, fromKid: _fromKid, ...fields } = parsed;
  const { id, type } = parsed;
  // на кадр без id ответа не ждут: только код
  const refuse = (word: string, status: number) => (id ? body(fail(id, word), status) : noBody(status === 200 ? 204 : status));

  let who;
  try {
    who = await within(gate.verify(String(key ?? "")), "gate не ответил на verify");
  } catch (e) {
    log(`gate_unavailable ${type} · ${e}`);
    return refuse("gate_unavailable", 503);
  }
  if ("error" in who) {
    log(`${who.error} ${type}`);
    return refuse(who.error, 200);
  }
  const sender = who.addr;

  let out: Frame[];
  try {
    out = await frame({ ...fields, type, from: sender, fromKid: who.kid });
  } catch (e) {
    log(`failed ${type} от ${sender} · ${e}`);
    return refuse("failed", 500);
  }
  const isAnswer = (o: Frame) => id && o.type === "reply" && o.id === id && o.to === sender;
  for (const o of out ?? []) {
    if (!isAnswer(o)) log(`relay_only ${o.type} → ${JSON.stringify(o.to)} · ответ на ${type} от ${sender}: такие кадры доставляет только relay`);
  }
  if (!id) return noBody(204);
  return body(((out ?? []).findLast(isAnswer) as Reply | undefined) ?? fail(id, "no_reply"));
}
