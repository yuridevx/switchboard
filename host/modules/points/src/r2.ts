// R2: PUT и GET блоков f/<отпечаток> прямо с машины по ссылкам из ответа реестра points — без ключа и своей подписи.

export type Fetch = typeof fetch;
/** Ссылка на блок по отпечатку: один блок, один метод, час. */
export type Links = Record<string, string>;

/** Положить блок по ссылке. Не вышло — исключение со статусом. */
export async function putBlock(links: Links, hash: string, body: Buffer, f: Fetch = fetch): Promise<void> {
  const r = links[hash] ? await f(links[hash], { method: "PUT", body: new Uint8Array(body) }) : null;
  if (!r?.ok) throw new Error(`R2 PUT f/${hash}: ${r ? r.status : "ссылки нет"}`);
}

/** Взять блок по ссылке. */
export async function getBlock(links: Links, hash: string, f: Fetch = fetch): Promise<Buffer> {
  const r = links[hash] ? await f(links[hash], { method: "GET" }) : null;
  if (!r?.ok) throw new Error(`R2 GET f/${hash}: ${r ? r.status : "ссылки нет"}`);
  return Buffer.from(await r.arrayBuffer());
}
