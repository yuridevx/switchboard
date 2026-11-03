// Файл → вложение session.prompt: имя, тип, данные base64.
import type { Attachment } from "../state/chat.ts";

export async function toAttachment(f: File): Promise<Attachment> {
  const buf = new Uint8Array(await f.arrayBuffer());
  let bin = "";
  for (const b of buf) bin += String.fromCharCode(b);
  return { name: f.name, media_type: f.type || "application/octet-stream", data: btoa(bin) };
}
