// Передача архивов по ссылкам «Выпусков» — одна для CI и модуля Host. Кто спрашивает «Выпуски» (relay, POST), решает вызывающий.
// Хэш уходит в запрос: тот же у этой версии лежит — same. Занята другим хэшем — лежащий архив скачивается и сравнивается
// без сжатия: gzip даёт разные байты на разных машинах при том же tar. Иначе PUT архива, затем PUT хэша: версия готова, когда лежит хэш.
import { gunzipSync } from "node:zlib";
import { sha256hex, shaLine } from "./layout.ts";

/** Предел одной передачи — как предел скачивания архива части у keeper. */
const LIMIT_MS = 10 * 60_000;

export type Answer = { ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> };
export type Net = (url: string, init: { method?: "PUT"; body?: Uint8Array<ArrayBuffer>; signal: AbortSignal }) => Promise<Answer>;

/** Ответ на releases.upload. */
export type UploadReply = { ok: true; result: { tgz: string; sha256: string } | { same: true } } | { ok: false; error: string };
/** Ответ на releases.fetch. */
export type FetchReply = { ok: true; result: { version: string; url: string } } | { ok: false; error: string };

/** Запрос к R2 с пределом. word — слово отказа, where — что назвать в нём. Прервал signal — причина его. */
async function exchange(net: Net, word: string, where: string, url: string, body?: Uint8Array, signal?: AbortSignal): Promise<Buffer> {
  const stop = new AbortController();
  let late = false;
  const timer = setTimeout(() => {
    late = true;
    stop.abort();
  }, LIMIT_MS);
  signal?.addEventListener("abort", () => stop.abort());
  try {
    const res = await net(url, { ...(body ? { method: "PUT" as const, body: new Uint8Array(body) } : {}), signal: stop.signal });
    if (!res.ok) throw new Refused(`${word}: R2 ответил ${res.status} на ${where}`);
    return body ? Buffer.alloc(0) : Buffer.from(await res.arrayBuffer());
  } catch (e) {
    if (e instanceof Refused) throw e;
    throw new Refused(`${word}: ${late ? `R2 не ответил за ${LIMIT_MS / 60_000} мин` : String(e)} на ${where}`);
  } finally {
    clearTimeout(timer);
  }
}
class Refused extends Error {}

/** Скачать архив по ссылке. Отказ и предел — исключение fetch_failed с именем where; вызывающий может прервать. */
export function download(url: string, o: { where: string; signal?: AbortSignal; net?: Net }): Promise<Buffer> {
  return exchange(o.net ?? fetch, "fetch_failed", o.where, url, undefined, o.signal);
}

/** Загрузить версию: ask — releases.upload с хэшем архива, look — releases.fetch этой версии. Отказ и сбой — исключение словами. */
export async function upload(version: string, tgz: Uint8Array, q: { ask(sha256: string): Promise<UploadReply>; look(): Promise<FetchReply> }, net: Net = fetch): Promise<{ done: "uploaded" | "same"; sha256: string }> {
  const sha256 = sha256hex(tgz);
  const r = await q.ask(sha256);
  if (!r.ok) {
    if (r.error !== "version_exists" || !(await sameTar(tgz, q.look, net))) throw new Error(`releases.upload: ${r.error}`);
    return { done: "same", sha256 };
  }
  if ("same" in r.result) return { done: "same", sha256 };
  const put = (url: string, body: Uint8Array) => exchange(net, "upload_failed", new URL(url).pathname, url, body);
  await put(r.result.tgz, tgz);
  await put(r.result.sha256, new TextEncoder().encode(shaLine(sha256, version)));
  return { done: "uploaded", sha256 };
}

async function sameTar(tgz: Uint8Array, look: () => Promise<FetchReply>, net: Net): Promise<boolean> {
  const r = await look();
  if (!r.ok) throw new Error(`releases.fetch: ${r.error}`);
  const lying = await download(r.result.url, { where: new URL(r.result.url).pathname, net });
  return gunzipSync(lying).equals(gunzipSync(tgz));
}
