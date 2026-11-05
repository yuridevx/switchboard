#!/usr/bin/env node
// gate seed — первая строка пропуска нового флота: инструкция вставки — в вывод, приглашение — в поток ошибок.
//   wrangler d1 execute switchboard-gate --remote --command "$(node seed.ts host laptop)"
//   node seed.ts client phone owner@example.com
// Принять приглашение — gate.redeem, как любое другое. В инструкции — только хэш.
import { isName, isPerson, isRole, newKid, newSecret, sha256 } from "./src/format.ts";

const [role, name, person] = process.argv.slice(2);
// почта идёт в текст инструкции: кавычка в ней недопустима
const personOk = role === "client" ? isPerson(person) && !person.includes("'") : person === undefined;
if (!isRole(role) || !isName(name) || !personOk) {
  console.error("использование: switchboard seed <host|client> <имя> [<почта человека у client>]");
  process.exit(2);
}
const kid = newKid();
const code = newSecret();
const personSql = person ? `'${person}'` : "NULL";
console.log(`INSERT INTO passes (id, role, name, person, state, hash, by, at) VALUES ('${kid}', '${role}', '${name}', ${personSql}, 'wait', '${await sha256(code)}', 'seed', ${Date.now()});`);
console.error(`${kid}.${code}`);
