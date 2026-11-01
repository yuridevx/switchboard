// Загрузка версии части машины: архив, затем его хэш. Номер загружается один раз: уже есть с тем же хэшем —
// пропуск (keeper без изменений между прогонами CI), с другим — исключение «подними номер».
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseSha, shaKey, shaLine, tgzKey } from "./format.ts";
import { s3 } from "./s3.ts";
import type { Fetch, S3Creds } from "./s3.ts";

/** Куда загружать: бакет R2 или местная папка той же раскладки. */
export type Bucket = {
  where: string;
  /** объект или null — его нет */
  get(key: string): Promise<Buffer | null>;
  put(key: string, body: Buffer): Promise<void>;
};

export function s3Bucket(c: S3Creds, f?: Fetch): Bucket {
  const b = s3(c, f);
  return {
    where: `${c.endpoint}/${c.bucket}`,
    async get(key) {
      const r = await b.get(key);
      if (r.status === 200) return r.body;
      if (r.status === 404) return null;
      throw new Error(`GET ${key}: ${r.status}`);
    },
    async put(key, body) {
      const r = await b.put(key, body);
      if (r.status !== 200) throw new Error(`PUT ${key}: ${r.status} ${r.body.toString("utf8").slice(0, 300)}`);
    },
  };
}

export function dirBucket(dir: string): Bucket {
  const p = (key: string) => join(dir, ...key.split("/"));
  return {
    where: dir,
    get: async (key) => (existsSync(p(key)) ? readFileSync(p(key)) : null),
    async put(key, body) {
      mkdirSync(dirname(p(key)), { recursive: true });
      writeFileSync(p(key), body);
    },
  };
}

/** Положить версию части: .tgz, затем .sha256. Ответ — загружена или уже была та же. */
export async function upload(b: Bucket, part: string, version: string, tgz: Buffer, sha: string): Promise<"uploaded" | "same"> {
  const had = await b.get(shaKey(part, version));
  if (had) {
    if (parseSha(had.toString("utf8")) === sha) return "same";
    throw new Error(`${shaKey(part, version)} уже есть в ${b.where} с другим хэшем — подними номер ${part}`);
  }
  await b.put(tgzKey(part, version), tgz);
  await b.put(shaKey(part, version), Buffer.from(shaLine(sha, version)));
  return "uploaded";
}
