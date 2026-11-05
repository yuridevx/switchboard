// Правила «Выпусков» без состояния: номера сборок, ячейка матрицы, слова отказа.
export type KPart = { part: string; version: string; state: string; pid?: number; restarts?: number; error?: string };
export type KState = { keeper: string; rev: number; os: string; parts: KPart[] };
export type Plan = Record<string, { pin?: string; on?: boolean }>;
export type CatalogPart = { where: string; edge: string; stable: string; versions: string[] };
export type Catalog = { parts: Record<string, CatalogPart>; machines: Array<{ machine: string; plan: Plan }>; rev: number; modules: Record<string, { into: string[]; built: Record<string, string>; edge: string }> };

/** «1.2.0+7» → «+7»; без сборки — номер целиком. */
export const short = (version: string) => (version.includes("+") ? `+${version.split("+")[1]}` : version);

/** Сборки старше stable, новые первыми. */
export const older = (p: CatalogPart) => p.versions.slice(0, Math.max(p.versions.indexOf(p.stable), 0)).reverse();

/** Что машина держит из части: у keeper — свой номер ответа. */
export const heldBy = (k: KState, part: string) => (part === "keeper" ? k.keeper : k.parts.find((p) => p.part === part)?.version);

export type Cell = { text: string; tone: "" | "behind" | "upd" | "fail" | "off" | "gone" };

/** Ячейка матрицы: что держит машина против плана. */
export function cellOf(k: KState | undefined, part: string, plan: Plan[string] | undefined, stable: string | undefined): Cell {
  if (!k) return { text: "не на связи", tone: "gone" };
  if (plan?.on === false) return { text: "выключена", tone: "off" };
  const version = heldBy(k, part);
  const state = k.parts.find((p) => p.part === part)?.state;
  if (!version) return { text: "—", tone: "off" };
  if (state === "failed") return { text: version, tone: "fail" };
  if (plan?.pin) return { text: `📌 ${version}`, tone: "" };
  if (state === "updating") return { text: stable ? `${version} → ${stable}` : version, tone: "upd" };
  return stable && version !== stable ? { text: `${version} → ${stable}`, tone: "behind" } : { text: version, tone: "" };
}

const WORDS: Record<string, string> = {
  check_failed: "проверка флота не прошла",
  no_release: "такой версии нет",
  no_build: "приложение не собирается «Выпусками»",
  no_part: "такой части нет",
  cf_failed: "Cloudflare не принял",
  bad_version: "номер версии не того вида",
  name_taken: "у адреса уже есть живой пропуск — сначала отзовите прежний",
  unknown_key: "такого пропуска нет",
  not_installed: "приложение GitHub не допущено к репозиторию",
  app_exists: "приложение GitHub флота уже есть",
};
export const wordFor = (word: string) => WORDS[word] ?? word;
