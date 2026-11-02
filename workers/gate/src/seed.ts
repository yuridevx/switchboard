// Первая строка пропуска нового флота: инструкция вставки и приглашение к ней. В инструкции — только хэш.
import { newKid, secret, sha256 } from "./key.ts";

const PART = /^[A-Za-z0-9_-]+$/;

export async function seed(role: string, name: string, person?: string): Promise<{ sql: string; invite: string } | null> {
  if ((role !== "host" && role !== "client") || !PART.test(name) || (role === "client") !== Boolean(person)) return null;
  if (person && !/^[^\s~@']+@[^\s~@']+$/.test(person)) return null;
  const kid = newKid();
  const code = secret();
  const p = person ? `'${person}'` : "NULL";
  return {
    sql: `INSERT INTO passes (id, role, name, person, state, hash, by, at) VALUES ('${kid}', '${role}', '${name}', ${p}, 'wait', '${await sha256(code)}', 'seed', ${Date.now()});`,
    invite: `${kid}.${code}`,
  };
}
