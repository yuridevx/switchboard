// Приём POST /incident без состояния: запрос локальный и по форме, тело — обращение известного типа. Иначе — отказ словом.
import type { IncomingMessage } from "node:http";
import { content, refuse } from "@switchboard/host";
import type { Attachment } from "@switchboard/host";
import { MAX_FRAME } from "@switchboard/protocol";

export type Appeal = { type: string; key?: string; text: string; attachments: Attachment[] };

/** Заголовок Host: страница из браузера с чужого имени сюда не достучится. */
const LOCAL = /^(127\.0\.0\.1|localhost)(:\d+)?$/;

export async function readBody(req: IncomingMessage): Promise<string> {
  if (req.method !== "POST" || req.url !== "/incident") throw refuse("bad_frame", `${req.method} ${req.url}: только POST /incident`);
  if (!LOCAL.test(req.headers.host ?? "")) throw refuse("bad_frame", `Host ${req.headers.host}: только 127.0.0.1 и localhost`);
  if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) throw refuse("bad_frame", `${req.headers["content-type"]}: только application/json`);
  const parts: Buffer[] = [];
  let size = 0;
  for await (const part of req as AsyncIterable<Buffer>) {
    size += part.length;
    if (size > MAX_FRAME) throw refuse("bad_frame", `тело больше ${MAX_FRAME} байт`);
    parts.push(part);
  }
  return Buffer.concat(parts).toString("utf8");
}

export function parseAppeal(body: string, isType: (type: string) => boolean): Appeal {
  let x: Record<string, unknown> | null;
  try {
    x = JSON.parse(body) as Record<string, unknown> | null;
  } catch {
    throw refuse("bad_frame", "тело не JSON");
  }
  const { type, key, text, attachments = [] } = x ?? {};
  if (typeof type !== "string" || !type) throw refuse("bad_frame", "type: нужен текст");
  if (key !== undefined && typeof key !== "string") throw refuse("bad_frame", "key: текст или нет поля");
  if (typeof text !== "string") throw refuse("bad_frame", "text: нужен текст");
  if (!Array.isArray(attachments)) throw refuse("bad_frame", "attachments: список");
  if (!isType(type)) throw refuse("unknown_type", `${type}: типа нет в host.json`);
  // блока для вложения нет — отказ сейчас, а не при доставке
  content(text, attachments as Attachment[]);
  return { type, ...(key === undefined ? {} : { key }), text, attachments: attachments as Attachment[] };
}
