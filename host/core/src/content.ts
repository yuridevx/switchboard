// Текст и вложения → содержимое сообщения user SDK. Одно правило для модулей, которые кладут ввод сессии:
// chat кладёт, incidents проверяет вложения ещё на приёме POST.
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Attachment } from "../contract.ts";
import { refuse } from "./refusal.ts";

/** Типы файлов, которые модель видит картинкой — блок image во вводе и в ответе инструмента MCP. Один список для модулей. */
export const IMAGE_TYPES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

type Content = Exclude<SDKUserMessage["message"]["content"], string>;
type Block = Content[number];

/**
 * Вложение → блок сообщения. data — base64 у всех типов (клиент шлёт файл как есть);
 * text/plain раскрывается в текст документа. Блока для типа нет — null.
 */
function block(a: Attachment): Block | null {
  if (IMAGE_TYPES.has(a.media_type)) return { type: "image", source: { type: "base64", media_type: a.media_type, data: a.data } } as Block;
  if (a.media_type === "application/pdf") return { type: "document", source: { type: "base64", media_type: "application/pdf", data: a.data } } as Block;
  if (a.media_type === "text/plain") return { type: "document", source: { type: "text", media_type: "text/plain", data: Buffer.from(a.data, "base64").toString("utf8") } } as Block;
  return null;
}

/** Текст и вложения — одно сообщение: без вложений — строка, иначе блоки по порядку. Блока для типа нет — отказ bad_attachment. */
export function content(text: string, attachments: Attachment[]): SDKUserMessage["message"]["content"] {
  if (!attachments.length) return text;
  const blocks: Block[] = text ? [{ type: "text", text } as Block] : [];
  for (const a of attachments) {
    const b = block(a);
    if (!b) throw refuse("bad_attachment", `${a.name}: ${a.media_type} — блока для типа нет; во ввод ничего не ушло`);
    blocks.push(b);
  }
  return blocks;
}
