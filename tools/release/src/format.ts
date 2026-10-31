// Формат выпуска Host в бакете: host/<версия>.tgz, host/<версия>.sha256 (строка как у sha256sum), host/latest.
import { createHash } from "node:crypto";

export const RELEASES_BUCKET = "switchboard-releases";

/** Версия выпуска — три числа. */
export const VERSION_RE = /^\d+\.\d+\.\d+$/;

export const latestKey = "host/latest";
export const tgzKey = (v: string) => `host/${v}.tgz`;
export const shaKey = (v: string) => `host/${v}.sha256`;

export const sha256hex = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

/** Строка .sha256: «<hex>  <версия>.tgz». */
export const shaLine = (hex: string, v: string) => `${hex}  ${v}.tgz\n`;

/** Хэш из строки .sha256; не того вида — null. */
export function parseSha(text: string): string | null {
  const h = text.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  return /^[0-9a-f]{64}$/.test(h) ? h : null;
}
