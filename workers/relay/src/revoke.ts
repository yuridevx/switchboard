// keys.revoke {kid} от вошедшего (from — адрес его пропуска): отметка у gate, закрытие соединений номера на объекте каждой машины.
import { accepts, fail, machineOf, ok, within, type Frame, type Reply } from "@switchboard/protocol";
import { call, type Env } from "./machine.ts";

const CONTRACT = { "keys.revoke": 1 };
const log = (line: string) => console.log(line);

/** Объект машины по имени. */
export const machineStub = (env: Env, machine: string) => env.FLEET.get(env.FLEET.idFromName(`m/${machine}`));

async function closeEverywhere(env: Env, kid: string, addr: string): Promise<{ closed: number; machines: number }> {
  const passes = await within(call(env.GATE.list("host")), "gate не ответил на list");
  // отозванная машина в списке gate уже не значится, а её соединения — на её объекте: объект берём из адреса
  const own = machineOf(addr);
  const machines = new Set([...passes.map((p) => p.name), ...(own ? [own] : [])]);
  const counts = await Promise.all([...machines].map((m) => within(machineStub(env, m).revoke(kid), `объект ${m} не ответил на close`)));
  return { closed: counts.reduce((a, b) => a + b, 0), machines: machines.size };
}

/** Кадр POST: ответ — кадры для отправителя. На кадр без id отвечать некому: запрос не исполняется. */
export async function revoke(env: Env, f: Frame): Promise<Frame[]> {
  if (!f.id) return [];
  const from = String(f.from);
  const answer = (r: Reply): Frame[] => [{ ...r, to: from }];
  const bad = accepts(f, CONTRACT);
  if (bad) return answer(fail(f.id, bad.word));
  if (typeof f.kid !== "string" || !f.kid) return answer(fail(f.id, "bad_request"));
  const done = await within(call(env.GATE.revoke(f.kid)), "gate не ответил на revoke");
  if ("error" in done) {
    log(`unknown_key ${f.kid} · отзыв от ${from}`);
    return answer(fail(f.id, done.error));
  }
  const { closed, machines } = await closeEverywhere(env, f.kid, done.addr);
  log(`revoke ${f.kid} ${done.addr} · отозвал ${from} · закрыто соединений ${closed} на ${machines} машинах`);
  return answer(ok(f.id, { addr: done.addr, closed }));
}
