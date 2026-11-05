// Слова и правила настроек: ответ keeper'а, ячейка матрицы, короткий номер версии, слова отказа.
/** Часть машины в ответе keeper.state. */
export type KPart = { part: string; version: string; state: string; pid?: number; restarts?: number; error?: string };
export type KState = { keeper: string; rev: number; os?: string; parts: KPart[] };
export type PlanEntry = { pin?: string; on?: boolean };
export type Part = { where: "machine" | "cloud"; edge: string; stable: string; versions: string[] };
export type ModuleRow = { into: string[]; built: Record<string, string>; edge: string };
export type Releases = { parts: Record<string, Part>; machines: Array<{ machine: string; plan: Record<string, PlanEntry> }>; rev: number; modules: Record<string, ModuleRow> };
export type Pass = { id: string; role: string; name: string; person: string | null; addr: string; state: string; by: string; at: number };

const WORDS: Record<string, string> = {
  no_release: "такой версии нет",
  no_build: "приложение не собирается «Выпусками»",
  no_part: "такой части нет",
  cf_failed: "Cloudflare не принял",
  bad_version: "номер версии не того вида",
  check_failed: "проверка флота не прошла",
  name_taken: "у адреса уже есть живой пропуск — сначала отзовите прежний",
  unknown_key: "такого пропуска нет",
  not_installed: "приложение GitHub не допущено к репозиторию",
  app_exists: "приложение GitHub флота уже есть",
};
/** Этот ли пропуск моего устройства: адрес от gate, пока его нет — имя из пропуска. */
export const isMe = (app: { address(): string | null; name: string }) => (p: Pass) => {
  const address = app.address();
  return address ? p.addr === address : p.role === "client" && p.name === app.name;
};

/** Отказ владельца словами; незнакомое — как есть. */
export const wordText = (word: string) => WORDS[word] ?? word;

/** Номер версии коротко: 1.2.0+7 → +7; без сборки — весь. */
export const short = (v: string) => (v.includes("+") ? `+${v.split("+")[1]}` : v);

/** Предыдущая сборка: на неё «Вернуть». */
export const before = (p: Part | undefined) => (p ? p.versions[p.versions.indexOf(p.stable) - 1] : undefined);

/** Ячейка матрицы: что написать и какой класс. */
export function cellOf(o: { part?: KPart; entry?: PlanEntry; stable?: string; online: boolean }): { text: string; cls: string; title?: string } {
  const { part, entry, stable, online } = o;
  if (entry?.on === false) return { text: "выключена", cls: "off" };
  const version = part?.version;
  if (!online || !part) return { text: version ?? entry?.pin ?? stable ?? "—", cls: "gone" };
  if (part.state === "failed") return { text: `${version} · сбой`, cls: "fail", title: part.error };
  if (entry?.pin) return { text: `📌 ${version}`, cls: "ok" };
  if (stable && version !== stable) return { text: `${version} → ${stable}`, cls: "behind" };
  return { text: version ?? "—", cls: "ok" };
}
