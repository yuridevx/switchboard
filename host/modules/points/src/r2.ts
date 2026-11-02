// R2: PUT и GET блоков f/<отпечаток> прямо с машины по ссылкам из ответа реестра points — без ключа и своей подписи.

export type Fetch = typeof fetch;
/** Ссылка на блок по отпечатку: один блок, один метод, час. */
export type Links = Record<string, string>;

/** Запрос по ссылке: статус не 2xx, обрыв сети или ссылки нет — одно исключение «R2 <метод> f/<отпечаток>: причина». */
async function call(method: "PUT" | "GET", links: Links, hash: string, f: Fetch, body?: Buffer): Promise<Response> {
  const why = (x: string) => new Error(`R2 ${method} f/${hash}: ${x}`);
  if (!links[hash]) throw why("ссылки нет");
  let r: Response;
  try {
    r = await f(links[hash], { method, ...(body ? { body: new Uint8Array(body) } : {}) });
  } catch (e) {
    throw why(String(e));
  }
  if (!r.ok) throw why(String(r.status));
  return r;
}

/** Положить блок по ссылке. Не вышло — исключение со статусом или причиной. */
export async function putBlock(links: Links, hash: string, body: Buffer, f: Fetch = fetch): Promise<void> {
  await call("PUT", links, hash, f, body);
}

/** Взять блок по ссылке. */
export async function getBlock(links: Links, hash: string, f: Fetch = fetch): Promise<Buffer> {
  return Buffer.from(await (await call("GET", links, hash, f)).arrayBuffer());
}
