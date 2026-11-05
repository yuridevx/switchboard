#!/usr/bin/env node
// Первое приглашение флота, когда пропусков ещё нет: инструкция вставки в stdout (для wrangler d1 execute), приглашение в stderr.
import { fieldsWrong, newKid, newSecret, sha256 } from "./src/format.ts";

const [role, name, person, ...rest] = process.argv.slice(2);
const fields = person === undefined ? { role, name } : { role, name, person };
// инструкция — текст SQL: кавычке в нём не место
if (rest.length > 0 || fieldsWrong(fields) || person?.includes("'")) {
  process.stderr.write("использование: switchboard seed <host|client> <имя> [<почта человека у client>]\n");
  process.exit(2);
}

const kid = newKid();
const secret = newSecret();
const who = person === undefined ? "NULL" : `'${person}'`;
process.stdout.write(`INSERT INTO passes (id, role, name, person, state, hash, by, at) VALUES ('${kid}', '${role}', '${name}', ${who}, 'wait', '${await sha256(secret)}', 'seed', ${Date.now()});\n`);
process.stderr.write(`${kid}.${secret}\n`);
