// Снятие точки: файлы разговора блоками, git, первые слова; реестру — points.put, недостающие блоки — по его ссылкам и повтор.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { Host, Session } from "@switchboard/host";
import { claudeDir, refuse } from "@switchboard/host";
import { cut, type PointFile, upload } from "./blocks.ts";
import { summarize } from "./git.ts";

export type Took = { point: number; same?: true };
/** Повод и поля подъёма. */
export type Why = { why: "rule" | "save" | "start" | "raise" | "yield"; base?: number; expect?: string; by?: string };

const FIRST_WORDS = 10;
const WORD_LIMIT = 160;

/** Папка проекта рабочей папки: так её называет Claude Code. */
export const projectDir = (cwd: string) => join(claudeDir(), "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
export const conversationOf = (cwd: string, sid: string) => join(projectDir(cwd), `${sid}.jsonl`);
export const hasConversation = (s: Session) => existsSync(conversationOf(s.info.cwd, s.info.session_id));

const walk = (dir: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name))
        .flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : e.isFile() ? [join(dir, e.name)] : []))
    : [];

type Msg = { type?: string; message?: { content?: unknown } };
const textOf = (m: Msg): string => {
  const c = m.message?.content;
  if (typeof c === "string") return c;
  return Array.isArray(c) ? ((c as Array<{ type?: string; text?: string }>).find((b) => b.type === "text")?.text ?? "") : "";
};

/** Последние обмены «вопрос → ответ». */
function firstWords(messages: Msg[]): string[][] {
  const pairs: string[][] = [];
  for (const m of messages) {
    const text = textOf(m).slice(0, WORD_LIMIT);
    if (m.type === "user" && text) pairs.push([text, ""]);
    else if (m.type === "assistant" && text && pairs.length && !pairs.at(-1)![1]) pairs.at(-1)![1] = text;
  }
  return pairs.slice(-FIRST_WORDS);
}

/** Снять точку. Отказ реестра и R2 — словом; строка журнала на месте отказа. */
export async function capture(host: Host, s: Session, why: Why): Promise<Took> {
  const { callsign, cwd, session_id: sid } = s.info;
  const no = (word: string, text: string, ev = "point") => {
    host.log({ kind: "refuse", ev, word, callsign, why: text });
    return refuse(word, text);
  };
  if (!hasConversation(s)) throw no("no_file", `${callsign}: файла разговора ещё нет`);

  const parts = new Map<string, Buffer>();
  const root = projectDir(cwd);
  const relative_ = (f: string) => relative(root, f).split(sep).join("/");
  const files: PointFile[] = [conversationOf(cwd, sid), ...walk(join(root, sid))].map((f) => cut(readFileSync(f), relative_(f), parts));
  const repo = await summarize(cwd);
  if (repo?.pack) files.push(cut(repo.pack, "git.bundle", parts));

  let words: { msgs: number; last: string[][] } | object = {};
  try {
    const messages = (await s.sdk("getSessionMessages")) as Msg[];
    words = { msgs: messages.length, last: firstWords(messages) };
  } catch (e) {
    host.log({ kind: "note", ev: "messages", callsign, why: e instanceof Error ? e.message : String(e) });
  }
  const spec = await host.request("session.spec", { callsign });

  const frame = { to: ".points", sid, callsign, dir: cwd, files, bytes: files.reduce((n, f) => n + f.size, 0), ...words, ...(repo ? { git: repo.git } : {}), ...(spec.ok ? { spec: spec.result } : {}), ...why };
  for (let tries = 0; ; tries++) {
    const r = await host.request("points.put", frame);
    if (r.ok) {
      const { id, same } = r.result as { id: number; same?: true };
      return same ? { point: id, same } : { point: id };
    }
    if (r.error !== "missing" || tries) throw no(r.error, `реестр: ${r.error}`);
    try {
      await upload(r.links as Record<string, string>, parts);
    } catch (e) {
      throw no("r2_failed", e instanceof Error ? e.message : String(e), "r2");
    }
  }
}
