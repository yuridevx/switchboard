// Загрузка версии по ссылкам «Выпусков» — одна функция для CI (switchboard release) и модуля Host parts (parts.upload).
// Хэш архива уходит в запрос: тот же хэш у этой версии уже лежит — пропуск; другой — отказ «Выпусков» словом.
// Иначе две ссылки: PUT архива, затем PUT .sha256 — версия готова, когда лежит хэш.
// Кто спрашивает «Выпуски» (relay, POST пропуском), решает вызывающий: функция получает только ответ на releases.upload.
import { sha256hex } from "./hash.ts";
import { shaLine } from "./format.ts";

/** Предел PUT архива и хэша в R2 — как предел скачивания архива части у keeper. */
export const PUT_MS = 10 * 60_000;

/** Ответ на releases.upload: две ссылки на запись или same — этот хэш уже лежит. */
export type UploadReply = { ok: true; result: { tgz: string; sha256: string } | { same: true } } | { ok: false; error: string };

export type Put = (url: string, init: { method: "PUT"; body: Uint8Array<ArrayBuffer>; signal: AbortSignal }) => Promise<{ ok: boolean; status: number }>;

/** Загрузить версию: ask — releases.upload с хэшем архива. Отказ и сбой PUT — исключение словами. */
export async function upload(ask: (sha256: string) => Promise<UploadReply>, version: string, tgz: Uint8Array, put: Put = fetch): Promise<{ done: "uploaded" | "same"; sha256: string }> {
  const sha256 = sha256hex(tgz);
  const r = await ask(sha256);
  if (!r.ok) throw new Error(`releases.upload: ${r.error}`);
  if ("same" in r.result) return { done: "same", sha256 };
  for (const [url, body] of [
    [r.result.tgz, tgz],
    [r.result.sha256, new TextEncoder().encode(shaLine(sha256, version))],
  ] as const) {
    const ac = new AbortController();
    const late = setTimeout(() => ac.abort(), PUT_MS);
    let res: { ok: boolean; status: number };
    try {
      res = await put(url, { method: "PUT", body: new Uint8Array(body), signal: ac.signal });
    } catch (e) {
      throw new Error(`upload_failed: ${ac.signal.aborted ? `R2 не ответил за ${PUT_MS / 60_000} мин` : String(e)} на ${new URL(url).pathname}`);
    } finally {
      clearTimeout(late);
    }
    if (!res.ok) throw new Error(`upload_failed: R2 ответил ${res.status} на ${new URL(url).pathname}`);
  }
  return { done: "uploaded", sha256 };
}
