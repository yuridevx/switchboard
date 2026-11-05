// Снесено: новый код — следующим коммитом.
import type { Attachment } from "../contract.ts";
export const IMAGE_TYPES: ReadonlySet<string> = new Set();
export function content(_text: string, _attachments: Attachment[]): string {
  throw new Error("снесено");
}
