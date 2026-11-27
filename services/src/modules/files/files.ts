// Файлы сессий: содержимое лежит в хранилище под своим хэшем SHA-256 — один раз на флот. Служба выдаёт подписанные ссылки
// на загрузку и чтение (байты идут мимо Worker'а). Записей и базы у модуля нет.
import { type FileIn, Refusal } from "@sb/protocol";
import type { Env, Module } from "../../env.ts";
import { link, uploadLinks } from "../../r2.ts";

/** Содержимое у флота своё: ссылку получает только человек или машина этого флота, знающие хэш. */
const fileKey = (fleet: string, hash: string) => `files/${fleet}/${hash}`;

/** Положить содержимое в хранилище флота под его хэшем; уже лежит — не трогается. Ответ — запись файла для сообщения или тикета. */
export async function store(env: Env, fleet: string, name: string, body: Uint8Array): Promise<FileIn> {
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", body))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const key = fileKey(fleet, hash);
  if (!(await env.FILES.head(key))) await env.FILES.put(key, body);
  return { name, hash, size: body.length };
}

/** Содержимое флота по хэшу; нет — null. */
export const read = (env: Env, fleet: string, hash: string): Promise<R2ObjectBody | null> => env.FILES.get(fileKey(fleet, hash));

export const files: Module = {
  name: "files",
  handlers: {
    async "files.put"(i: { files: { hash: string; size: number }[] }, ctx) {
      return { upload: await uploadLinks(ctx.env, [...new Set(i.files.map((f) => f.hash))], (hash) => fileKey(ctx.fleet, hash)) };
    },

    async "files.get"(i: { hash: string; name?: string }, ctx) {
      const key = fileKey(ctx.fleet, i.hash);
      if (!(await ctx.env.FILES.head(key))) throw new Refusal("no_file", `содержимого ${i.hash.slice(0, 12)} в хранилище нет`);
      // с именем ссылка отдаёт файл вложением: браузер скачивает его под этим именем
      return { url: await link(ctx.env, "GET", key, i.name ? { "response-content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(i.name)}` } : {}) };
    },
  },
};
