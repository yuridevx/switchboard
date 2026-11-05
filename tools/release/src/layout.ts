// Раскладка выпуска в бакете: имена ключей, номера версий, строка хэша.
import { createHash } from "node:crypto";

export const RELEASES_BUCKET = "switchboard-releases";

export const isVersion = (v: unknown): v is string => typeof v === "string" && /^\d+\.\d+\.\d+$/.test(v);
/** Номер сборки «Выпусков»: версия ядра и «+n». */
export const isBuild = (v: unknown): v is string => typeof v === "string" && /^\d+\.\d+\.\d+\+\d+$/.test(v);

const numbers = (v: string) => v.split(/[.+]/).map(Number);

/** Порядок версий и сборок: по числам, сборка «+n» новее своего ядра. */
export function byVersion(a: string, b: string): number {
  const x = numbers(a);
  const y = numbers(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

export const tgzKey = (part: string, version: string) => `${part}/${version}.tgz`;
export const shaKey = (part: string, version: string) => `${part}/${version}.sha256`;

export const sha256hex = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
/** Строка как у sha256sum. */
export const shaLine = (hash: string, version: string) => `${hash}  ${version}.tgz\n`;
/** Хэш из строки .sha256: первое слово. */
export const parseSha = (line: string) => line.trim().split(/\s+/)[0];
