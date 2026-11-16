// Подписанные ссылки R2 на час: загрузить (PUT) или скачать (GET) файл мимо Worker'а.
import { AwsClient } from "aws4fetch";
import { Refusal } from "@sb/protocol";
import type { Env } from "./env.ts";

const HOUR = 3600;
const HEADS_AT_ONCE = 50;

/** query — параметры ответа хранилища, которые подписываются вместе со ссылкой: имя скачиваемого файла. */
export async function link(env: Env, method: "PUT" | "GET", key: string, query: Record<string, string> = {}): Promise<string> {
  if (!env.R2_ACCOUNT_ID || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY) throw new Refusal("no_links", "ключи R2 не заданы: ссылки не подписать");
  const aws = new AwsClient({ accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY, service: "s3", region: "auto" });
  const url = new URL(`https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.FILES_BUCKET}/${key.split("/").map(encodeURIComponent).join("/")}`);
  url.searchParams.set("X-Amz-Expires", String(HOUR));
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const signed = await aws.sign(new Request(url, { method }), { aws: { signQuery: true } });
  return signed.url;
}

/** Шаг «чего ещё нет → ссылка на загрузку»: один для блоков архива и файлов сессий. names — хэши содержимого, key — ключ хранилища по хэшу.
 *  В ответе ссылки только для тех, чьего содержимого в хранилище нет: что уже лежит, второй раз не грузится. */
export async function uploadLinks(env: Env, names: string[], key: (name: string) => string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (let i = 0; i < names.length; i += HEADS_AT_ONCE) {
    const part = names.slice(i, i + HEADS_AT_ONCE);
    const heads = await Promise.all(part.map((n) => env.FILES.head(key(n))));
    for (const [n, name] of part.entries()) if (!heads[n]) out[name] = await link(env, "PUT", key(name));
  }
  return out;
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
