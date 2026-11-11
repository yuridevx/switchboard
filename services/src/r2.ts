// Подписанные ссылки R2 на час: загрузить (PUT) или скачать (GET) файл мимо Worker'а.
import { AwsClient } from "aws4fetch";
import { Refusal } from "@sb/protocol";
import type { Env } from "./env.ts";

const HOUR = 3600;

export async function link(env: Env, method: "PUT" | "GET", key: string): Promise<string> {
  if (!env.R2_ACCOUNT_ID || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY) throw new Refusal("no_links", "ключи R2 не заданы: ссылки не подписать");
  const aws = new AwsClient({ accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY, service: "s3", region: "auto" });
  const url = new URL(`https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.FILES_BUCKET}/${key.split("/").map(encodeURIComponent).join("/")}`);
  url.searchParams.set("X-Amz-Expires", String(HOUR));
  const signed = await aws.sign(new Request(url, { method }), { aws: { signQuery: true } });
  return signed.url;
}

/** Блок лежит в хранилище сжатым (gzip): разговор — текст, на живом флоте он сжимается в 3,5 раза (замер 10 нояб.: 564 → 159 КБ). Имя блока — хэш несжатого содержимого. */
export async function gzip(data: Uint8Array | string): Promise<Uint8Array> {
  const body = new Response(typeof data === "string" ? new TextEncoder().encode(data) : data).body!;
  return new Uint8Array(await new Response(body.pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
}
export async function gunzip(data: ArrayBuffer | Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await new Response(new Response(data).body!.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
}

/** Файл целиком из блоков по порядку. Блока нет — отказ. */
export async function readBlocks(env: Env, keys: string[]): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for (const k of keys) {
    const o = await env.FILES.get(k);
    if (!o) throw new Refusal("blocks_missing", `блока ${k} нет в хранилище`);
    parts.push(await gunzip(await o.arrayBuffer()).catch(() => {
      throw new Refusal("bad_point", `блок ${k} в хранилище не распаковался`);
    }));
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) (out.set(p, at), (at += p.length));
  return out;
}
