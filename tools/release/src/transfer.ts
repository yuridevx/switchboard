// Загрузка и скачивание архива каталога: один путь у CLI и инструмента сессии.
import { gunzipSync } from "node:zlib";
import { shaLine } from "./layout.ts";

/** Ответ на запрос к «Выпускам». */
export type Answer<T> = { ok: true; result: T } | { ok: false; error: string; why?: string };
export type UploadReply = { tgz: string; sha256: string } | { same: true };
export type FetchReply = { version: string; url: string };
/** Сеть: fetch платформы или подделка теста. */
export type Net = (url: string, init: { method: string; body?: Uint8Array | string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; arrayBuffer?(): Promise<ArrayBuffer> }>;

type Ask = <T>(type: string, body: Record<string, unknown>) => Promise<Answer<T>>;

/** Предел передачи — как у keeper на скачивание части. */
const TRANSFER_MS = 10 * 60_000;
const minutes = (ms: number) => `${ms / 60_000} мин`;

const refused = (type: string, a: { error: string; why?: string }) => new Error(`${type}: ${a.error}${a.why ? ` — ${a.why}` : ""}`);

/** Запрос в R2 с пределом; остановка вызывающего снимает его. */
async function transfer(net: Net, url: string, init: { method: string; body?: Uint8Array | string }, word: string, what: string, stop?: AbortSignal) {
  const ac = new AbortController();
  const late = setTimeout(() => ac.abort(new Error("late")), TRANSFER_MS);
  const signal = stop ? AbortSignal.any([ac.signal, stop]) : ac.signal;
  try {
    const r = await net(url, { ...init, signal });
    if (!r.ok) throw new Error(`${word}: R2 ответил ${r.status} на ${what}`);
    return r;
  } catch (e) {
    if (String((e as Error).message).startsWith(word)) throw e;
    throw new Error(ac.signal.aborted ? `${word}: R2 не ответил за ${minutes(TRANSFER_MS)} на ${what}` : `${word}: ${String(e)} на ${what}`);
  } finally {
    clearTimeout(late);
  }
}

/** Ссылка на чтение и байты архива. */
export async function download(ask: Ask, net: Net, part: string, version: string | undefined, name: string | null, stop?: AbortSignal): Promise<{ version: string; tgz: Buffer }> {
  const a = await ask<FetchReply>("releases.fetch", { part, ...(version ? { version } : {}) });
  if (!a.ok) throw refused("releases.fetch", a);
  const what = name ?? `${part} ${a.result.version}`;
  const r = await transfer(net, a.result.url, { method: "GET" }, "fetch_failed", what === "" ? new URL(a.result.url).pathname : what, stop);
  return { version: a.result.version, tgz: Buffer.from(await r.arrayBuffer!()) };
}

/** Номер занят: тот же tar другим сжатием — та же версия (gzip на разных машинах даёт разные байты). */
async function sameTar(ask: Ask, net: Net, part: string, version: string, tgz: Uint8Array): Promise<boolean> {
  const held = await download(ask, net, part, version, "");
  return gunzipSync(held.tgz).equals(gunzipSync(tgz));
}

/** Загрузить версию: ссылки у «Выпусков», архив, затем хэш — версия готова. same: такой уже лежит. */
export async function upload(ask: Ask, net: Net, m: { name: string; version: string; tgz: Uint8Array; sha: string }): Promise<{ same: boolean }> {
  const a = await ask<UploadReply>("releases.upload", { part: m.name, version: m.version, sha256: m.sha });
  if (!a.ok) {
    if (a.error === "version_exists" && (await sameTar(ask, net, m.name, m.version, m.tgz))) return { same: true };
    throw refused("releases.upload", a);
  }
  if ("same" in a.result) return { same: true };
  const pathOf = (url: string) => new URL(url).pathname;
  await transfer(net, a.result.tgz, { method: "PUT", body: m.tgz }, "upload_failed", pathOf(a.result.tgz));
  await transfer(net, a.result.sha256, { method: "PUT", body: shaLine(m.sha, m.version) }, "upload_failed", pathOf(a.result.sha256));
  return { same: false };
}
