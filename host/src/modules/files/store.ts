// Обмен с хранилищем флота по подписанным ссылкам: один на файлы сессий и на блоки точек архива. Байты идут мимо Worker'а и мимо соединения машины.
import { createHash } from "node:crypto";
import { CALL_MS, Refusal } from "@sb/protocol";

export const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

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

/** Содержимое — в хранилище по ссылке загрузки. */
export async function storePut(url: string, body: Buffer, signal?: AbortSignal): Promise<void> {
  await storeFetch(url, { method: "PUT", body: body as unknown as RequestInit["body"] }, signal);
}
