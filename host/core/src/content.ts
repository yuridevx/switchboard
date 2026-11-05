// Текст и вложения → содержимое сообщения user SDK. Одно правило для модулей, которые кладут ввод сессии.
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Attachment } from "../contract.ts";
import { refuse } from "./refusal.ts";

/** Типы файлов, которые модель видит картинкой — блок image во вводе и в ответе инструмента MCP. */
export const IMAGE_TYPES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

type Blocks = Exclude<SDKUserMessage["message"]["content"], string>;

/** Вложение → блок. data — base64 у всех типов; text/plain раскрывается в текст документа. Блока для типа нет — null. */
function blockOf(a: Attachment): Blocks[number] | null {
  if (IMAGE_TYPES.has(a.media_type)) return { type: "image", source: { type: "base64", media_type: a.media_type, data: a.data } } as Blocks[number];
  if (a.media_type === "application/pdf") return { type: "document", source: { type: "base64", media_type: "application/pdf", data: a.data } } as Blocks[number];
  if (a.media_type === "text/plain") return { type: "document", source: { type: "text", media_type: "text/plain", data: Buffer.from(a.data, "base64").toString("utf8") } } as Blocks[number];
  return null;
}

/** Текст и вложения — одно сообщение: без вложений — строка, иначе блоки по порядку. Блока для типа нет — отказ bad_attachment. */
export function content(text: string, attachments: Attachment[]): SDKUserMessage["message"]["content"] {
  if (!attachments.length) return text;
  const blocks: Blocks = text ? [{ type: "text", text } as Blocks[number]] : [];
  for (const a of attachments) {
    const block = blockOf(a);
    if (!block) throw refuse("bad_attachment", `${a.name}: ${a.media_type} — блока для типа нет; во ввод ничего не ушло`);
    blocks.push(block);
  }
  return blocks;
}
