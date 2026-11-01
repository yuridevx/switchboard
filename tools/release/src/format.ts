// Формат выпуска частей машины в бакете switchboard-releases: <часть>/<версия>.tgz и <часть>/<версия>.sha256
// (строка как у sha256sum). Версия готова, когда лежит .sha256: он пишется вторым.

export const RELEASES_BUCKET = "switchboard-releases";

/** Версия — три числа. */
export const VERSION_RE = /^\d+\.\d+\.\d+$/;

export const tgzKey = (part: string, v: string) => `${part}/${v}.tgz`;
export const shaKey = (part: string, v: string) => `${part}/${v}.sha256`;

/** Строка .sha256: «<hex>  <версия>.tgz». */
export const shaLine = (hex: string, v: string) => `${hex}  ${v}.tgz\n`;

/** Хэш из строки .sha256; не того вида — null. */
export function parseSha(text: string): string | null {
  const h = text.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  return /^[0-9a-f]{64}$/.test(h) ? h : null;
}
