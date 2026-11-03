// Мелочи подписей карточек.
import { duration, plural } from "@switchboard/web-ui";

/** Токены: 182 К, 950. */
export const kTokens = (n?: number) => (typeof n === "number" ? (n >= 1000 ? `${Math.round(n / 1000)} К` : String(n)) : "?");
export const money = (n: number) => `$${n.toFixed(2).replace(".", ",")}`;
export const steps = (n: number) => `${n} ${plural(n, "шаг", "шага", "шагов")}`;
/** Имя файла пути (Windows и Unix). */
export const baseName = (p?: string) => String(p ?? "").replace(/\\/g, "/").split("/").pop() ?? "";
/** Первая непустая строка, не длиннее n. */
export const firstLine = (s?: string, n = 140) => {
  const l = String(s ?? "").split("\n").find((x) => x.trim()) ?? "";
  return l.length > n ? `${l.slice(0, n)}…` : l;
};
/** Модель по-человечески: claude-opus-5-5 → Opus 5.5. */
export const modelName = (m?: string) =>
  !m
    ? ""
    : m
        .replace(/^claude-/, "")
        .replace(/-(\d+)-(\d+)(-.*)?$/, " $1.$2")
        .replace(/-(\d+)(-\d{8})?$/, " $1")
        .replace(/^\w/, (c) => c.toUpperCase());
export { duration };
