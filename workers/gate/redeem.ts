#!/usr/bin/env node
// switchboard redeem — приём приглашения: приглашение — из stdin, пропуск — в stdout, отказ — словом в поток ошибок.
//   <приглашение> | node redeem.ts https://switchboard-gate.<subdomain>.workers.dev/
// Секрет пропуска рождается у gate и уходит один раз — в ответе на этот запрос.

/** предел запроса к gate */
const LIMIT_MS = 30_000;

type Answer = { ok: boolean; result?: { key: string }; error?: string };

/** Код выхода: process.exit оборвал бы вывод в канал на Windows. */
async function redeem(gate: string | undefined): Promise<number> {
  if (!gate || !/^https?:\/\//.test(gate) || process.stdin.isTTY) {
    console.error("использование: <приглашение в stdin> | switchboard redeem <адрес gate>");
    return 2;
  }
  const invite = Buffer.concat(await process.stdin.toArray()).toString("utf8").trim();
  let reply: Answer;
  try {
    const res = await fetch(gate, { method: "POST", body: JSON.stringify({ type: "gate.redeem", id: "redeem", v: 1, invite }), signal: AbortSignal.timeout(LIMIT_MS) });
    reply = await res.json();
  } catch (e) {
    console.error(`redeem: gate не ответил — ${(e as Error).message}`);
    return 1;
  }
  if (!reply.ok || !reply.result) {
    console.error(`redeem: ${reply.error}`);
    return 1;
  }
  console.log(reply.result.key);
  return 0;
}

process.exitCode = await redeem(process.argv[2]);
