#!/usr/bin/env node
// Первое приглашение флота, когда пропусков ещё нет: инструкция вставки в stdout, приглашение в stderr; секрета в инструкции нет.
//   wrangler d1 execute switchboard-gate --remote --command "$(node seed.ts @laptop ~ann@example.com)"
import { fieldsWrong, newKid, newSecret, sha256 } from "./src/format.ts";

const [addr, owner] = process.argv.slice(2);
// инструкция — текст SQL: кавычке в нём не место
if (fieldsWrong({ addr, owner }) || `${addr}${owner ?? ""}`.includes("'")) {
  process.stderr.write("использование: switchboard seed <@машина | устройство~почта> [~почта владельца машины]\n");
  process.exitCode = 2;
} else {
  const kid = newKid();
  const secret = newSecret();
  process.stdout.write(`INSERT INTO passes (id, addr, owner, state, hash, by, at) VALUES ('${kid}', '${addr}', ${owner ? `'${owner}'` : "NULL"}, 'wait', '${await sha256(secret)}', 'seed', ${Date.now()});\n`);
  process.stderr.write(`${kid}.${secret}\n`);
}
