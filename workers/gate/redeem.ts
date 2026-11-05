#!/usr/bin/env node
// Приём приглашения программой: приглашение в stdin, адрес gate аргументом, пропуск в stdout. Секрет не бывает в argv.
// Одним файлом, без зависимостей: идёт и вне репо.
import { text } from "node:stream/consumers";

const LIMIT_MS = 30_000;

async function redeem(gate: string | undefined): Promise<number> {
  // терминал без канала ждал бы ввод без предела
  if (!gate || !/^https?:\/\//.test(gate) || process.stdin.isTTY) {
    process.stderr.write("использование: <приглашение в stdin> | switchboard redeem <адрес gate>\n");
    return 2;
  }
  const invite = (await text(process.stdin)).trim();
  try {
    const res = await fetch(gate, { method: "POST", body: JSON.stringify({ type: "gate.redeem", id: "redeem", v: 1, invite }), signal: AbortSignal.timeout(LIMIT_MS) });
    const r = (await res.json()) as { ok: boolean; result?: { key: string }; error?: string };
    process[r.ok ? "stdout" : "stderr"].write(r.ok ? `${r.result!.key}\n` : `redeem: ${r.error}\n`);
    return r.ok ? 0 : 1;
  } catch (e) {
    process.stderr.write(`redeem: gate не ответил — ${(e as Error).message}\n`);
    return 1;
  }
}

process.exitCode = await redeem(process.argv[2]);
