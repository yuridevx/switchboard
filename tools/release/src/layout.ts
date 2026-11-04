// Раскладка бакета и номера версий — одно правило для CI, «Выпусков» и модуля Host.
//   <часть>/<версия>.tgz      архив
//   <часть>/<версия>.sha256   «<hex>  <версия>.tgz», как у sha256sum; пишется вторым — версия готова
import { createHash } from "node:crypto";

export const RELEASES_BUCKET = "switchboard-releases";

export const tgzKey = (part: string, version: string) => `${part}/${version}.tgz`;
export const shaKey = (part: string, version: string) => `${part}/${version}.sha256`;
export const shaLine = (hex: string, version: string) => `${hex}  ${version}.tgz\n`;

/** Хэш из строки .sha256; не того вида — null. */
export function parseSha(line: string): string | null {
  const first = line.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  return /^[0-9a-f]{64}$/.test(first) ? first : null;
}

export const sha256hex = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");

/** Номер: версия каталога — три числа, сборка — ещё «+n». */
export const isVersion = (v: string) => /^\d+\.\d+\.\d+(\+\d+)?$/.test(v);
export const isBuild = (v: string) => v.includes("+");

/** Порядок номеров: 1.1.10 новее 1.1.9, 1.2.0+10 новее 1.2.0+9. */
export function byVersion(a: string, b: string): number {
  const [x, y] = [a, b].map((v) => v.split(/[.+]/).map(Number));
  for (let i = 0; i < 4; i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d;
  }
  return 0;
}
