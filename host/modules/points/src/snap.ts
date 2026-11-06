// Снять точку: файлы разговора и пакет git → блоки → points.put → недостающие блоки PUT по ссылкам реестра.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import { zstdCompress } from "node:zlib";
import { claudeDir, refuse } from "@switchboard/host";
import { CALL_MS } from "@switchboard/protocol";
import type { Host, Result, Session } from "@switchboard/host";
import { BUNDLE, snapshot } from "./git.ts";

/** Формат блоков — контракт хранилища: 1 МиБ, отпечаток SHA-256 содержимого, в R2 — zstd. */
const BLOCK = 1 << 20;
const EXCHANGES = 10;
const WORDS = 160;
const pack = promisify(zstdCompress);

export type PointFile = { p: string; size: number; b: string[] };
export type Why = "rule" | "save" | "start" | "raise" | "yield";
export type PointExtra = { base?: number; expect?: string; by?: string };
type Blocks = Map<string, Buffer>;

export const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
/** Папка проекта рабочей папки: так её называет Claude Code. */
export const projectDir = (cwd: string) => join(claudeDir(), "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
export const conversationOf = (s: Session) => join(projectDir(s.info.cwd), `${s.info.session_id}.jsonl`);
const r2Failed = (host: Host, why: string) => {
  host.log({ kind: "refuse", ev: "r2", word: "r2_failed", why });
  return refuse("r2_failed", why);
};

/** Запрос к R2 по ссылке реестра: сеть или отказ — слово r2_failed. */
export async function r2Fetch(host: Host, url: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(CALL_MS) }).catch((e) => {
    throw r2Failed(host, `R2: ${e}`);
  });
  if (!res.ok) throw r2Failed(host, `R2 ответил ${res.status}`);
  return res;
}

/** Файл блоками; разговор — по последний перевод строки: хвост ещё дописывается. */
function toBlocks(p: string, buf: Buffer, blocks: Blocks): PointFile {
  const size = p.endsWith(".jsonl") ? buf.lastIndexOf(0x0a) + 1 : buf.length;
  const b: string[] = [];
  for (let off = 0; off < size; off += BLOCK) {
    const part = buf.subarray(off, Math.min(size, off + BLOCK));
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

const textOf = (m: { message?: { content?: unknown } }) => {
  const c = m.message?.content;
  if (typeof c === "string") return c;
  return Array.isArray(c) ? ((c as Array<{ type?: string; text?: string }>).find((x) => x.type === "text")?.text ?? "") : "";
};

/** Первые слова: последние обмены вопрос → ответ, обрезанные; сообщений — сколько отдал SDK. */
async function words(host: Host, s: Session) {
  try {
    const messages = (await s.sdk("getSessionMessages")) as Array<{ type?: string; message?: { content?: unknown } }>;
    const pairs: string[][] = [];
    for (const m of messages) {
      const text = textOf(m).slice(0, WORDS);
      if (!text) continue;
      if (m.type === "user") pairs.push([text, ""]);
      else if (m.type === "assistant" && pairs.length) pairs[pairs.length - 1][1] ||= text;
    }
    return { msgs: messages.length, last: pairs.slice(-EXCHANGES) };
  } catch (e) {
    host.log({ kind: "note", ev: "messages", callsign: s.info.callsign, why: e instanceof Error ? e.message : String(e) });
    return {};
  }
}

async function upload(host: Host, links: Record<string, string>, blocks: Blocks) {
  for (const [hash, url] of Object.entries(links)) await r2Fetch(host, url, { method: "PUT", body: new Uint8Array(await pack(blocks.get(hash)!)) });
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
  const frame = { to: ".points", sid, why, files, callsign, dir: cwd, bytes, git: git?.summary, spec: spec.ok ? spec.result : undefined, ...(await words(host, s)), ...extra };
  let put: Result = await host.request("points.put", frame);
  if (!put.ok && put.error === "missing") {
    await upload(host, put.links as Record<string, string>, blocks);
    put = await host.request("points.put", frame);
  }
  if (!put.ok) throw refuse(put.error, put.why as string | undefined);
  return put.result as { id: number; same?: true };
}
