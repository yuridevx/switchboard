#!/usr/bin/env node
// switchboard redeem — приём приглашения: приглашение — из stdin, пропуск — в stdout, отказ — словом в поток ошибок.
//   <приглашение> | node redeem.ts https://switchboard-gate.<subdomain>.workers.dev/
// Секрет пропуска рождается у gate и уходит один раз — в ответе на этот запрос.

const USAGE = "использование: <приглашение в stdin> | switchboard redeem <адрес gate>";
/** предел запроса к gate */
const LIMIT_MS = 30_000;

async function readStdin(): Promise<string> {
  const parts: Buffer[] = [];
  for await (const c of process.stdin) parts.push(c as Buffer);
  return Buffer.concat(parts).toString("utf8").trim();
}

async function main(argv: string[]): Promise<number> {
  const [gate] = argv;
  if (!gate || !/^https?:\/\//.test(gate) || process.stdin.isTTY) {
    console.error(USAGE);
    return 2;
  }
  const invite = await readStdin();
  let r: { ok: boolean; result?: { key: string }; error?: string };
  try {
    const res = await fetch(gate, { method: "POST", body: JSON.stringify({ type: "gate.redeem", id: "redeem", v: 1, invite }), signal: AbortSignal.timeout(LIMIT_MS) });
    r = await res.json();
  } catch (e) {
    console.error(`redeem: gate не ответил — ${(e as Error).message}`);
    return 1;
  }
  if (!r.ok || !r.result) {
    console.error(`redeem: ${r.error}`);
    return 1;
  }
  console.log(r.result.key);
  return 0;
}

process.exitCode = await main(process.argv.slice(2));
