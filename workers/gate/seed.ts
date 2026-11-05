#!/usr/bin/env node
// Первая строка пропуска нового флота: инструкция вставки — в вывод, приглашение — в поток ошибок. В инструкции только хэш.
//   wrangler d1 execute switchboard-gate --remote --command "$(node seed.ts host laptop)"
import { fieldsWrong, newKid, newSecret, sha256 } from "./src/format.ts";

const [role, name, person] = process.argv.slice(2);
// почта идёт в текст инструкции: кавычка в ней недопустима
if (fieldsWrong(role, name, person) || person?.includes("'")) {
  console.error("использование: switchboard seed <host|client> <имя> [<почта человека у client>]");
  process.exit(2);
}
const kid = newKid();
const code = newSecret();
console.log(`INSERT INTO passes (id, role, name, person, state, hash, by, at) VALUES ('${kid}', '${role}', '${name}', ${person ? `'${person}'` : "NULL"}, 'wait', '${await sha256(code)}', 'seed', ${Date.now()});`);
console.error(`${kid}.${code}`);
