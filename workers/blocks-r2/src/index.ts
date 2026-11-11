// Worker blocks-r2: контракт blocks на R2. Ссылки — подпись S3 на час прямо в бакет, тело блока Worker не видит; поиска нет.
import { WorkerEntrypoint } from "cloudflare:workers";
import { CONTRACT, HASH } from "@switchboard/blocks";
import { accepts, fail, ok, type Frame } from "@switchboard/protocol";
import { presign } from "@switchboard/release";
import type { Env } from "./env.ts";

/** Удаление в R2 — не больше тысячи ключей за вызов. */
const R2_BATCH = 1000;

const key = (hash: string) => `f/${hash}`;
const log = (row: Record<string, unknown>) => console.log(JSON.stringify({ t: new Date().toISOString(), part: "blocks-r2", ...row }));

class Refusal extends Error {
  word: string;
  constructor(word: string, why: string) {
    super(why);
    this.word = word;
  }
}

function hashesOf(f: Frame): string[] {
  const { hashes } = f;
  if (!Array.isArray(hashes) || !hashes.every((h) => typeof h === "string" && HASH.test(h))) throw new Refusal("bad_frame", "hashes — не отпечатки SHA-256");
  return [...new Set(hashes as string[])];
}

const link = (env: Env, method: "GET" | "PUT", hash: string) =>
  presign({ accessKeyId: env.R2_KEY_ID, secretAccessKey: env.R2_KEY_SECRET }, { method, host: `${env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com`, path: `/${env.BLOCKS_BUCKET}/${key(hash)}` });
const links = async (env: Env, method: "GET" | "PUT", hashes: string[]) => Object.fromEntries(await Promise.all(hashes.map(async (h) => [h, await link(env, method, h)])));

const REQUESTS: Record<keyof typeof CONTRACT, (env: Env, f: Frame) => Promise<unknown>> = {
  async "blocks.links"(env, f) {
    const hashes = hashesOf(f);
    if (f.method === "GET") return { links: await links(env, "GET", hashes) };
    if (f.method !== "PUT") throw new Refusal("bad_frame", `метод ${String(f.method)}`);
    const heads = await Promise.all(hashes.map(async (h) => [h, await env.BUCKET.head(key(h))] as const));
    const have = Object.fromEntries(heads.flatMap(([h, o]) => (o ? [[h, o.size]] : [])));
    return { have, links: await links(env, "PUT", heads.filter(([, o]) => !o).map(([h]) => h)) };
  },

  async "blocks.drop"(env, f) {
    const hashes = hashesOf(f);
    const heads = (await Promise.all(hashes.map((h) => env.BUCKET.head(key(h))))).filter((o) => o !== null);
    for (let i = 0; i < heads.length; i += R2_BATCH) await env.BUCKET.delete(heads.slice(i, i + R2_BATCH).map((o) => o.key));
    return { blocks: heads.length, bytes: heads.reduce((n, o) => n + o.size, 0) };
  },

  async "blocks.search"() {
    throw new Refusal("no_search", "хранилище флота — R2: поиска по блокам нет");
  },
};

export class Blocks extends WorkerEntrypoint<Env> {
  /** Кадр от points по привязке → ответ. Отказ — словом и строкой журнала. */
  async frame(f: Frame): Promise<Frame[]> {
    const { id, type } = f;
    try {
      const off = accepts(f, CONTRACT);
      if (off) throw new Refusal(off.word, off.why);
      return [ok(id as string, await REQUESTS[type as keyof typeof CONTRACT](this.env, f))];
    } catch (e) {
      if (!(e instanceof Refusal)) throw e;
      if (e.word !== "no_search") log({ kind: "refuse", ev: type, word: e.word, why: e.message });
      return [fail(id as string, e.word)];
    }
  }
}

export default { fetch: () => new Response(null, { status: 404 }) };
