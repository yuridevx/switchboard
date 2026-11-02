#!/usr/bin/env node
// gate seed — первая строка пропуска нового флота: инструкция вставки — в вывод, приглашение — в поток ошибок.
//   wrangler d1 execute switchboard-gate --remote --command "$(node seed.ts host laptop)"
//   node seed.ts client phone owner@example.com
// Принять приглашение — gate.redeem, как любое другое.
import { seed } from "./src/seed.ts";

const s = await seed(process.argv[2] ?? "", process.argv[3] ?? "", process.argv[4]);
if (!s) {
  console.error("использование: switchboard seed <host|client> <имя> [<почта человека у client>]");
  process.exit(2);
}
console.log(s.sql);
console.error(s.invite);
