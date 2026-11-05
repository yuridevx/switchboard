#!/usr/bin/env node
// Приём приглашения программой: приглашение из stdin, пропуск в вывод, отказ словом в поток ошибок. Без зависимостей.
import { text } from "node:stream/consumers";

const LIMIT_MS = 30_000;

/** Код выхода, а не process.exit: он оборвал бы вывод в канал на Windows. */
async function redeem(gate: string | undefined): Promise<number> {
  if (!gate || !/^https?:\/\//.test(gate) || process.stdin.isTTY) {
    console.error("использование: <приглашение в stdin> | switchboard redeem <адрес gate>");
    return 2;
  }
  const invite = (await text(process.stdin)).trim();
  let reply: { ok: boolean; result?: { key: string }; error?: string };
  try {
    const res = await fetch(gate, { method: "POST", body: JSON.stringify({ type: "gate.redeem", id: "redeem", v: 1, invite }), signal: AbortSignal.timeout(LIMIT_MS) });
    reply = (await res.json()) as typeof reply;
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
