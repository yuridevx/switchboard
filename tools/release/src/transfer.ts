// Загрузка и скачивание по ссылкам «Выпусков»: одна функция у CLI и инструмента сессии. Как спросить «Выпуски», говорит вызывающий.
import { gunzipSync } from "node:zlib";
import { shaLine } from "./sign.ts";

/** Предел обмена с R2: как у keeper на скачивание архива части. */
const LINK_MS = 10 * 60_000;

export type Answer = { ok: true; result?: unknown } | { ok: false; error: string; why?: unknown };
type Response = { ok: boolean; status: number; arrayBuffer?(): Promise<ArrayBuffer> };
export type Net = {
  ask(type: string, frame: Record<string, unknown>): Promise<Answer>;
  fetch(url: string, init: { method: string; body?: Uint8Array; signal: AbortSignal }): Promise<Response>;
};
/** Слова ошибки обмена: причина → вся строка. */
type Say = (why: string) => string;

/** Отказ запроса словами. */
export const refused = (type: string, r: { error: string; why?: unknown }): string => `${type}: ${r.error}${r.why ? ` — ${r.why}` : ""}`;

async function exchange(net: Net, url: string, method: string, say: Say, o: { body?: Uint8Array; signal?: AbortSignal } = {}): Promise<Buffer> {
  const stop = new AbortController();
  const limit = setTimeout(() => stop.abort(say("R2 не ответил за 10 мин")), LINK_MS);
  const signal = o.signal ? AbortSignal.any([stop.signal, o.signal]) : stop.signal;
  try {
    const r = await net.fetch(url, { method, body: o.body, signal });
    if (!r.ok) throw say(`R2 ответил ${r.status}`);
    return r.arrayBuffer ? Buffer.from(await r.arrayBuffer()) : Buffer.alloc(0);
  } catch (e) {
    throw new Error(stop.signal.aborted ? stop.signal.reason : typeof e === "string" ? e : say(String(e)));
  } finally {
    clearTimeout(limit);
  }
}

export const download = (net: Net, url: string, say: Say, signal?: AbortSignal): Promise<Buffer> => exchange(net, url, "GET", say, { signal });

/**
 * Версия в каталог: архив, затем хэш — он делает её готовой. same — такая уже лежит: тот же хэш или, у занятого номера, тот же tar:
 * gzip на разных машинах даёт разные байты при том же tar.
 */
export async function upload(net: Net, m: { name: string; version: string; tgz: Buffer; sha: string }, signal?: AbortSignal): Promise<{ same?: true }> {
  const version = { part: m.name, version: m.version };
  const on = (url: string, word: string): Say => (why) => `${word}: ${why} на ${new URL(url).pathname}`;
  const r = await net.ask("releases.upload", { ...version, sha256: m.sha });
  if (!r.ok) {
    if (r.error !== "version_exists") throw new Error(refused("releases.upload", r));
    const got = await net.ask("releases.fetch", version);
    if (!got.ok) throw new Error(refused("releases.fetch", got));
    const { url } = got.result as { url: string };
    if (!gunzipSync(await download(net, url, on(url, "fetch_failed"), signal)).equals(gunzipSync(m.tgz))) throw new Error(refused("releases.upload", r));
    return { same: true };
  }
  const links = r.result as { same: true } | { tgz: string; sha256: string };
  if ("same" in links) return { same: true };
  await exchange(net, links.tgz, "PUT", on(links.tgz, "upload_failed"), { body: m.tgz, signal });
  await exchange(net, links.sha256, "PUT", on(links.sha256, "upload_failed"), { body: Buffer.from(shaLine(m.sha, m.version)), signal });
  return {};
}
