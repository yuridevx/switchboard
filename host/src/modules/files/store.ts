// Обмен с хранилищем флота по подписанным ссылкам: один на файлы сессий и на блоки точек архива. Байты идут мимо Worker'а и мимо соединения машины.
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readSync, statSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { CALL_MS, Refusal } from "@sb/protocol";

export const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** Хэш файла на диске — кусками: большой файл в память целиком не берётся. */
export function fileHash(file: string): string {
  const hash = createHash("sha256");
  const buf = Buffer.allocUnsafe(1 << 20);
  const fd = openSync(file, "r");
  try {
    for (let n = readSync(fd, buf); n > 0; n = readSync(fd, buf)) hash.update(buf.subarray(0, n));
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

/** Сбой обмена словом: предел вышел — timeout; Host останавливается — shutting_down; остальное — store_failed. */
function refuse(e: unknown): never {
  const name = (e as Error)?.name;
  if (name === "TimeoutError") throw new Refusal("timeout", "хранилище: обмен не уложился в предел запроса");
  if (name === "AbortError") throw new Refusal("shutting_down", "Host останавливается: обмен с хранилищем оборван");
  throw new Refusal("store_failed", `хранилище: ${e}`);
}

/** Запрос к хранилищу по ссылке под пределом signal (по умолчанию — предел запроса флота): содержимого нет — слово missing; сеть или другой отказ — store_failed. */
export async function storeFetch(url: string, init: RequestInit = {}, signal: AbortSignal = AbortSignal.timeout(CALL_MS)): Promise<Response> {
  const res = await fetch(url, { ...init, signal }).catch(refuse);
  if (res.status === 404) throw new Refusal("missing", "содержимого нет в хранилище");
  if (!res.ok) throw new Refusal("store_failed", `хранилище ответило ${res.status}`);
  return res;
}

/** Содержимое по ссылке целиком. */
export async function storeGet(url: string, signal?: AbortSignal): Promise<Buffer> {
  const res = await storeFetch(url, {}, signal);
  return Buffer.from(await res.arrayBuffer().catch(refuse));
}

/** Содержимое по ссылке — в файл на диске, с того места, где он кончается. Обрыв (предел запроса, остановка Host, сеть) оставляет принятое:
 *  повтор докачивает остальное, а не начинает заново — файл, который не уложился в один запрос, приходит за несколько. Сверка хэша — дело зовущего. */
export async function storeInto(url: string, file: string, signal?: AbortSignal): Promise<void> {
  const have = existsSync(file) ? statSync(file).size : 0;
  const res = await fetch(url, { headers: have ? { range: `bytes=${have}-` } : {}, signal: signal ?? AbortSignal.timeout(CALL_MS) }).catch(refuse);
  // всё содержимое уже на диске: докачивать нечего
  if (res.status === 416) return void (await res.body?.cancel());
  if (res.status === 404) throw new Refusal("missing", "содержимого нет в хранилище");
  if (!res.ok || !res.body) throw new Refusal("store_failed", `хранилище ответило ${res.status}`);
  mkdirSync(dirname(file), { recursive: true });
  // 206 — хранилище отдало остаток; 200 — содержимое целиком: файл пишется заново
  const fd = openSync(file, res.status === 206 ? "a" : "w");
  try {
    for await (const chunk of res.body) writeSync(fd, chunk as Uint8Array);
  } catch (e) {
    refuse(e);
  } finally {
    closeSync(fd);
  }
}

/** Содержимое — в хранилище по ссылке загрузки. */
export async function storePut(url: string, body: Buffer, signal?: AbortSignal): Promise<void> {
  await storeFetch(url, { method: "PUT", body: body as unknown as RequestInit["body"] }, signal);
}
