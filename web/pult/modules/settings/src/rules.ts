// Правила «Выпусков» без состояния: номера сборок, ячейка матрицы, слова отказа.
export type KPart = { part: string; version: string; state: string; pid?: number; restarts?: number; error?: string };
export type KState = { keeper: string; rev: number; os: string; parts: KPart[] };
export type Plan = Record<string, { pin?: string; on?: boolean }>;
export type CatalogPart = { where: string; edge: string; stable: string; versions: string[] };
export type Catalog = { parts: Record<string, CatalogPart>; machines: Array<{ machine: string; plan: Plan }>; rev: number; modules: Record<string, { into: string[]; built: Record<string, string>; edge: string }> };

/** «1.2.0+7» → «+7»; без сборки — номер целиком. */
export const short = (version: string) => (version.includes("+") ? `+${version.split("+")[1]}` : version);

/** Сборки старше stable, новые первыми: на них «Вернуть». */
export const older = (p: CatalogPart) => p.versions.slice(0, Math.max(p.versions.indexOf(p.stable), 0)).reverse();
/** Версии, кроме stable, новые первыми. */
export const others = (p: CatalogPart) => p.versions.filter((v) => v !== p.stable).reverse();

/** Что машина держит из части: у keeper — свой номер ответа. */
export const heldBy = (k: KState, part: string) => (part === "keeper" ? k.keeper : k.parts.find((p) => p.part === part)?.version);

export type Cell = { text: string; tone: "ok" | "behind" | "upd" | "fail" | "off" | "gone"; title?: string };

/** Ячейка матрицы: что написать и какой цвет; части на машине нет и в плане её нет — пусто. */
export function cellOf(k: KState | undefined, online: boolean, part: string, plan: Plan[string] | undefined, stable: string | undefined): Cell | null {
  const held = k?.parts.find((p) => p.part === part);
  const version = k && heldBy(k, part);
  const want = plan?.pin ?? stable;
  const mark = (text: string) => (plan?.pin ? `📌 ${text}` : text);
  if (!online || !k) return version || plan || want ? { text: mark(version ?? want ?? "—"), tone: "gone" } : null;
  if (!version && !plan && !want) return null;
  if (plan?.on === false) return { text: mark("выключена"), tone: "off" };
  if (held?.state === "failed") return { text: mark(`${version ?? "?"} · сбой`), tone: "fail", title: held.error };
  if (version && want && version !== want) return { text: mark(`${version} → ${want}`), tone: held?.state === "starting" || held?.state === "updating" ? "upd" : "behind" };
  return { text: mark(version ?? want ?? "—"), tone: "ok" };
}

/** Этот ли пропуск моего устройства: адрес от gate, пока его нет — имя из пропуска. */
export const isMine = (app: { address(): string | null; name: string }, p: { addr: string; name: string; role: string }) => {
  const address = app.address();
  return address ? p.addr === address : p.role === "client" && p.name === app.name;
};

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
