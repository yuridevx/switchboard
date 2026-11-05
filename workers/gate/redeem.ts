#!/usr/bin/env node
// Приём приглашения программой: приглашение в stdin, адрес gate аргументом, пропуск в stdout. Секрет не бывает в argv.
import { text } from "node:stream/consumers";
import { CALL_MS } from "@switchboard/protocol";

const [gate] = process.argv.slice(2);
if (!/^https?:\/\//.test(gate ?? "")) {
  process.stderr.write("использование: <приглашение в stdin> | switchboard redeem <адрес gate>\n");
  process.exit(2);
}

const invite = (await text(process.stdin)).trim();
try {
  const res = await fetch(gate, { method: "POST", body: JSON.stringify({ type: "gate.redeem", id: "redeem", v: 1, invite }), signal: AbortSignal.timeout(CALL_MS) });
  const r = (await res.json()) as { ok: boolean; result?: { key: string }; error?: string };
  if (r.ok) process.stdout.write(`${r.result!.key}\n`);
  else {
    process.stderr.write(`redeem: ${r.error}\n`);
    process.exitCode = 1;
  }
} catch (e) {
  process.stderr.write(`redeem: gate не ответил — ${(e as Error).message}\n`);
  process.exitCode = 1;
}
