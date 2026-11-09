// Снять точку: файлы разговора и пакет git → блоки → points.put → недостающие блоки PUT по ссылкам хранилища, что отдал реестр.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import { zstdCompress } from "node:zlib";
import { claudeDir, refuse } from "@switchboard/host";
import { CALL_MS } from "@switchboard/protocol";
import type { Host, Result, Session } from "@switchboard/host";
import { BUNDLE, snapshot } from "./git.ts";

/** Формат блоков — контракт хранилища: до 1 МиБ, отпечаток SHA-256 содержимого, тело по ссылке — zstd. */
const BLOCK = 1 << 20;
const pack = promisify(zstdCompress);

export type PointFile = { p: string; size: number; b: string[] };
export type Why = "rule" | "save" | "start" | "raise" | "yield";
export type PointExtra = { base?: number; expect?: string; by?: string };
type Blocks = Map<string, Buffer>;

export const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
/** Папка проекта рабочей папки: так её называет Claude Code. */
export const projectDir = (cwd: string) => join(claudeDir(), "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
export const conversationOf = (s: Session) => join(projectDir(s.info.cwd), `${s.info.session_id}.jsonl`);
const storeFailed = (host: Host, why: string) => {
  host.log({ kind: "refuse", ev: "store", word: "store_failed", why });
  return refuse("store_failed", why);
};

/** Запрос к хранилищу по ссылке: сеть или отказ — слово store_failed. */
export async function storeFetch(host: Host, url: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(CALL_MS) }).catch((e) => {
    throw storeFailed(host, `хранилище: ${e}`);
  });
  if (!res.ok) throw storeFailed(host, `хранилище ответило ${res.status}`);
  return res;
}

/** Конец блока с off: у разговора — последний перевод строки до 1 МиБ, чтобы каждая строка блока была целой записью; строка длиннее — целиком. */
function endOf(buf: Buffer, off: number, size: number, lines: boolean): number {
  const end = Math.min(size, off + BLOCK);
  if (!lines || end === size) return end;
  const nl = buf.lastIndexOf(0x0a, end - 1);
  return nl >= off ? nl + 1 : buf.indexOf(0x0a, end) + 1 || size;
}

/** Файл блоками; разговор — по последний перевод строки: хвост ещё дописывается. */
export function toBlocks(p: string, buf: Buffer, blocks: Blocks): PointFile {
  const lines = p.endsWith(".jsonl");
  const size = lines ? buf.lastIndexOf(0x0a) + 1 : buf.length;
  const b: string[] = [];
  for (let off = 0, end = 0; off < size; off = end) {
    end = endOf(buf, off, size, lines);
    const part = buf.subarray(off, end);
    const hash = sha256(part);
    b.push(hash);
    blocks.set(hash, part);
  }
  return { p, size, b };
}

/** Разговор и файлы рядом с ним: подагенты и прочее в папке сессии. */
function conversation(s: Session, blocks: Blocks): PointFile[] {
  const dir = projectDir(s.info.cwd);
  const sid = s.info.session_id;
  const side = join(dir, sid);
  const names = existsSync(side) ? readdirSync(side, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => relative(dir, join(e.parentPath, e.name)).split("\\").join("/")) : [];
  return [`${sid}.jsonl`, ...names.sort()].map((p) => toBlocks(p, readFileSync(join(dir, p)), blocks));
}

type Usage = { input_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number; output_tokens?: number };
type Said = { type?: string; message?: { id?: string; model?: string; usage?: Usage } };

/**
 * Сводка сессии в строке точки: заголовок — getSessionInfo SDK, модель последнего ответа и токены основной нити — по ответам модели
 * (запись одного ответа повторяется на каждый блок содержимого: считается один раз по id); сообщений — сколько отдал SDK.
 */
async function summaryOf(host: Host, s: Session) {
  try {
    const messages = (await s.sdk("getSessionMessages")) as Said[];
    const info = (await s.sdk("getSessionInfo")) as { summary?: string } | undefined;
    const seen = new Set<string>();
    let tok_in = 0;
    let tok_out = 0;
    let model: string | undefined;
    for (const m of messages) {
      if (m.type !== "assistant" || !m.message?.usage) continue;
      const { id, usage: u, model: said } = m.message;
      if (said && said !== "<synthetic>") model = said;
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      tok_in += (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
      tok_out += u.output_tokens ?? 0;
    }
    return { msgs: messages.length, ...(info?.summary ? { title: info.summary } : {}), ...(model ? { model } : {}), tok_in, tok_out };
  } catch (e) {
    host.log({ kind: "note", ev: "messages", callsign: s.info.callsign, why: e instanceof Error ? e.message : String(e) });
    return {};
  }
}

async function upload(host: Host, links: Record<string, string>, blocks: Blocks) {
  for (const [hash, url] of Object.entries(links)) await storeFetch(host, url, { method: "PUT", body: new Uint8Array(await pack(blocks.get(hash)!)) });
}

/** Снять точку сессии; ответ реестра — номер и same. Отказ реестра — его словом. */
export async function snap(host: Host, s: Session, why: Why, extra: PointExtra = {}): Promise<{ id: number; same?: true }> {
  const { callsign, session_id: sid, cwd } = s.info;
  if (!existsSync(conversationOf(s))) throw refuse("no_file", `${callsign}: файла разговора ещё нет`);
  const blocks: Blocks = new Map();
  const files = conversation(s, blocks);
  const git = await snapshot(cwd);
  if (git?.bundle) files.push(toBlocks(BUNDLE, git.bundle, blocks));
  const bytes = files.reduce((n, f) => n + f.size, 0);
  const spec = await host.read("session.spec", { callsign });
  const frame = { to: ".points", sid, why, files, callsign, dir: cwd, bytes, git: git?.summary, spec: spec.ok ? spec.result : undefined, ...(await summaryOf(host, s)), ...extra };
  let put: Result = await host.request("points.put", frame);
  if (!put.ok && put.error === "missing") {
    await upload(host, put.links as Record<string, string>, blocks);
    put = await host.request("points.put", frame);
  }
  if (!put.ok) throw refuse(put.error, put.why as string | undefined);
  return put.result as { id: number; same?: true };
}
