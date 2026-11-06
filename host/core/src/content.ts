// Ввод сессии: текст и вложения → содержимое сообщения user.
import type { Attachment } from "../contract.ts";
import { refuse } from "./refusal.ts";

/** Типы файлов, которые модель видит картинкой. */
export const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

function block({ name, media_type, data }: Attachment) {
  if (IMAGE_TYPES.has(media_type)) return { type: "image", source: { type: "base64", media_type, data } };
  if (media_type === "application/pdf") return { type: "document", source: { type: "base64", media_type, data } };
  if (media_type === "text/plain") return { type: "document", source: { type: "text", media_type, data: Buffer.from(data, "base64").toString("utf8") } };
  throw refuse("bad_attachment", `${name}: ${media_type} — блока для типа нет; во ввод ничего не ушло`);
}

export function content(text: string, attachments: Attachment[] = []): any {
  if (!attachments.length) return text;
  return [...(text ? [{ type: "text", text }] : []), ...attachments.map(block)];
}
