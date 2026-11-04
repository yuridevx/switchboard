// Приём POST /incident: только с этой машины, не со страницы браузера; тело — type, key?, text, attachments?. Состояния нет.
import type { IncomingMessage } from "node:http";
import type { Attachment } from "@switchboard/host";
import { content, isRefusal } from "@switchboard/host";

export type Appeal = { type: string; key?: string; text: string; attachments: Attachment[] };
type Refused = { word: string; why: string };

const no = (word: string, why: string): Refused => ({ word, why });

/** Запрос и тело → обращение; неверный вход — слово с причиной. known — есть ли такой тип в настройке машины. */
export function parse(req: IncomingMessage, body: string, port: number, known: (type: string) => boolean): Appeal | Refused {
  if (req.method !== "POST" || req.url !== "/incident") return no("bad_frame", `${req.method} ${req.url}: только POST /incident`);
  if (req.headers.host !== `127.0.0.1:${port}` && req.headers.host !== `localhost:${port}`) return no("bad_frame", `Host ${req.headers.host}: только 127.0.0.1 и localhost`);
  const type_ = req.headers["content-type"] ?? "";
  if (!type_.toLowerCase().startsWith("application/json")) return no("bad_frame", `Content-Type ${req.headers["content-type"]}: только application/json`);
  let f: Record<string, unknown>;
  try {
    f = (JSON.parse(body) ?? {}) as Record<string, unknown>;
  } catch {
    return no("bad_frame", "тело не JSON");
  }
  const { type, key, text, attachments = [] } = f;
  if (typeof type !== "string" || !type) return no("bad_frame", "type: нужен текст");
  if (key !== undefined && typeof key !== "string") return no("bad_frame", "key: текст или нет поля");
  if (typeof text !== "string") return no("bad_frame", "text: нужен текст");
  if (!Array.isArray(attachments)) return no("bad_frame", "attachments: список");
  if (!known(type)) return no("unknown_type", `${type}: типа нет в host.json`);
  try {
    content(text, attachments as Attachment[]);
  } catch (e) {
    if (!isRefusal(e)) throw e;
    return no(e.word, e.why ?? e.word);
  }
  return { type, ...(key !== undefined ? { key } : {}), text, attachments: attachments as Attachment[] };
}

export const isAppeal = (x: Appeal | Refused): x is Appeal => !("word" in x);
