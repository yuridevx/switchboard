// Содержимое сообщения user из текста и вложений.
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Attachment } from "../contract.ts";
import { refuse } from "./refusal.ts";

/** Типы файлов, которые модель видит картинкой. */
export const IMAGE_TYPES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

function block(a: Attachment): unknown {
  if (IMAGE_TYPES.has(a.media_type)) return { type: "image", source: { type: "base64", media_type: a.media_type, data: a.data } };
  if (a.media_type === "application/pdf") return { type: "document", source: { type: "base64", media_type: a.media_type, data: a.data } };
  if (a.media_type.startsWith("text/")) return { type: "document", source: { type: "text", media_type: "text/plain", data: Buffer.from(a.data, "base64").toString("utf8") } };
  throw refuse("bad_attachment", `${a.name}: ${a.media_type} — блока для типа нет; во ввод ничего не ушло`);
}

export function content(text: string, attachments: Attachment[] = []): SDKUserMessage["message"]["content"] {
  if (!attachments.length) return text;
  return [...(text ? [{ type: "text", text }] : []), ...attachments.map(block)] as SDKUserMessage["message"]["content"];
}
