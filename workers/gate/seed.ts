#!/usr/bin/env node
// Первое приглашение флота, когда пропусков ещё нет: инструкция вставки в stdout, приглашение в stderr; секрета в инструкции нет.
//   wrangler d1 execute switchboard-gate --remote --command "$(node seed.ts host laptop)"
import { fieldsWrong, newKid, newSecret, sha256 } from "./src/format.ts";

const [role, name, person] = process.argv.slice(2);
// инструкция — текст SQL: кавычке в нём не место
if (fieldsWrong(person === undefined ? { role, name } : { role, name, person }) || person?.includes("'")) {
  process.stderr.write("использование: switchboard seed <host|client> <имя> [<почта человека у client>]\n");
  process.exitCode = 2;
} else {
  const kid = newKid();
  const secret = newSecret();
  const who = person === undefined ? "NULL" : `'${person}'`;
  process.stdout.write(`INSERT INTO passes (id, role, name, person, state, hash, by, at) VALUES ('${kid}', '${role}', '${name}', ${who}, 'wait', '${await sha256(secret)}', 'seed', ${Date.now()});\n`);
  process.stderr.write(`${kid}.${secret}\n`);
}
