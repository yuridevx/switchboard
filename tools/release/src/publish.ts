// Выкладка выпуска: архив, его хэш и последним — host/latest. Версия выпускается один раз.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { latestKey, shaKey, shaLine, tgzKey } from "./format.ts";
import { s3 } from "./s3.ts";
import type { Fetch, S3Creds } from "./s3.ts";

/** Куда выкладывать: бакет R2 или местная папка той же раскладки. */
export type Bucket = {
  where: string;
  exists(key: string): Promise<boolean>;
  put(key: string, body: Buffer): Promise<void>;
};

export function s3Bucket(c: S3Creds, f?: Fetch): Bucket {
  const b = s3(c, f);
  return {
    where: `${c.endpoint}/${c.bucket}`,
    async exists(key) {
      const r = await b.head(key);
      if (r.status === 200) return true;
      if (r.status === 404) return false;
      throw new Error(`HEAD ${key}: ${r.status}`);
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
    exists: async (key) => existsSync(p(key)),
    async put(key, body) {
      mkdirSync(dirname(p(key)), { recursive: true });
      writeFileSync(p(key), body);
    },
  };
}

/** Версия уже выпущена — исключение. */
export async function assertNew(b: Bucket, version: string): Promise<void> {
  if (await b.exists(shaKey(version))) throw new Error(`${shaKey(version)} уже есть в ${b.where} — версия выпускается один раз`);
}

/** Положить выпуск: .tgz, .sha256, последним latest. */
export async function publish(b: Bucket, version: string, tgz: Buffer, sha: string): Promise<string[]> {
  await assertNew(b, version);
  await b.put(tgzKey(version), tgz);
  await b.put(shaKey(version), Buffer.from(shaLine(sha, version)));
  await b.put(latestKey, Buffer.from(version + "\n"));
  return [tgzKey(version), shaKey(version), latestKey];
}
