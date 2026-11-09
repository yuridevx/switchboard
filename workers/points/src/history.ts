// points.history — разговор точки тем же кодом, что session.history живой сессии: getSessionMessages закреплённого SDK над строками
// файла разговора точки (sessionStore). Своего разбора разговора нет. calls — вызовы модели из записей api-request файла: исключение
// «только документированного», как методы query вне типов SDK; записи пропали — calls пуст, строка журнала no_calls.
import { createHash } from "node:crypto";
import { zstdDecompressSync } from "node:zlib";
import { CALL_MS } from "@switchboard/protocol";
import type { Call, PointFile } from "../contract.ts";

type Entry = { type?: string; uuid?: string; id?: string; timestamp?: string; requestRef?: string; shapeHash?: string; params?: { model?: string }; shape?: { system?: unknown }; message?: { id?: string; usage?: Usage } };
type Usage = { input_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number; output_tokens?: number };
type Message = { uuid: string };

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** Строки файла разговора точки: блоки по ссылкам GET хранилища, zstd, SHA-256 — имя блока. Не тот блок — ошибка словом вызывающего. */
export async function linesOf(file: PointFile, links: Record<string, string>, refuse: (why: string) => Error): Promise<Entry[]> {
  const parts: Uint8Array[] = [];
  for (const hash of file.b) {
    const res = await fetch(links[hash], { signal: AbortSignal.timeout(CALL_MS) }).catch((e) => {
      throw refuse(`блок ${hash}: ${e}`);
    });
    if (!res.ok) throw refuse(`блок ${hash}: хранилище ответило ${res.status}`);
    const part = zstdDecompressSync(new Uint8Array(await res.arrayBuffer()));
    if (sha256(part) !== hash) throw refuse(`блок ${hash} не тот`);
    parts.push(part);
  }
  const text = new TextDecoder().decode(Buffer.concat(parts));
  return text.split("\n").flatMap((line) => {
    if (!line) return [];
    try {
      return [JSON.parse(line) as Entry];
    } catch {
      return [];
    }
  });
}

/** Разговор основной нити — getSessionMessages SDK; SDK грузится при первом чтении: его код нужен только этому запросу. */
export async function messagesOf(sid: string, entries: Entry[]): Promise<Message[]> {
  const { getSessionMessages } = await import("@anthropic-ai/claude-agent-sdk");
  const store = { append: async () => {}, load: async (k: { sessionId: string; subpath?: string }) => (k.sessionId === sid && !k.subpath ? entries : null), listSubkeys: async () => [] };
  return (await getSessionMessages(sid, { includeSystemMessages: true, sessionStore: store as never })) as unknown as Message[];
}

const systemOf = (shape: Entry["shape"]) => {
  const s = shape?.system;
  if (typeof s === "string") return s;
  return Array.isArray(s) ? s.map((x: { text?: string }) => x.text ?? "").join("\n\n") : "";
};

/** Вызовы модели: запись api-request, её форма (system) и первый ответ модели со ссылкой requestRef на неё. */
export function callsOf(entries: Entry[]): Call[] {
  const shapes = new Map<string, string>();
  const requests = new Map<string, Entry>();
  const calls: Call[] = [];
  for (const e of entries) {
    if (e.type === "api-request-shape" && e.shapeHash) shapes.set(e.shapeHash, systemOf(e.shape));
    else if (e.type === "api-request" && e.id) requests.set(e.id, e);
    else if (e.type === "assistant" && e.requestRef && e.uuid && requests.has(e.requestRef)) {
      const r = requests.get(e.requestRef)!;
      requests.delete(e.requestRef);
      const u = e.message?.usage ?? {};
      calls.push({
        uuid: e.uuid,
        at: r.timestamp ?? e.timestamp ?? "",
        model: r.params?.model ?? "",
        tok_in: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
        tok_out: u.output_tokens ?? 0,
        system: shapes.get(r.shapeHash ?? "") ?? "",
      });
    }
  }
  return calls;
}

/** Страница с конца, как session.history; вызовы — те, чей ответ на странице или назван в before. */
export function page(messages: Message[], calls: Call[], before: string | null, limit: number) {
  const end = before === null ? messages.length : messages.findIndex((m) => m.uuid === before);
  if (end < 0) return null;
  const start = Math.max(0, end - limit);
  const shown = messages.slice(start, end);
  const near = new Set([...shown.map((m) => m.uuid), ...(before ? [before] : [])]);
  return { messages: shown, calls: calls.filter((c) => near.has(c.uuid)), more: start > 0 };
}
