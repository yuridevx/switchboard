// Правила вкладки «Выпуски» и слова отказов: чистые функции над ответами владельцев, без состояния.
import { linkText, okOf } from "@switchboard/web-ui";
export type Entry = { pin?: string; on?: boolean; force?: boolean };
export type Listed = {
  parts: Record<string, { where: "machine" | "cloud"; edge: string | null; stable: string | null; versions?: string[] }>;
  machines: Array<{ machine: string; plan: Record<string, Entry> }>;
  rev: number;
  modules?: Record<string, { into: string[]; built: Record<string, string>; edge: string | null }>;
};
export type KPart = { part: string; version?: string; state?: string; pid?: number; restarts?: number; error?: string };
export type KState = { keeper?: string; rev?: number; os?: string; parts?: KPart[] };
export type Err = { error: string };
export type Cell = { k: "ok" | "upd" | "behind" | "fail" | "off" | "gone"; t: string; pin?: string; why?: string };

/** Что знают правила: каталог, ответы keeper'ов и машины на связи. */
export type ReleaseData = { list: Listed | Err | null; kst: Record<string, KState | Err>; online: string[] };

/** Слова отказа → строка на экране. */
export function say(w: string): string {
  const t: Record<string, string> = {
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
  return t[w] ?? linkText(w);
}

/** Порядок номеров: 1.1.10 новее 1.1.9, 1.2.0+10 новее 1.2.0+9. */
export function cmpV(a: string, b: string): number {
  const x = a.split(/[.+]/).map(Number);
  const y = b.split(/[.+]/).map(Number);
  for (let i = 0; i < 4; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}

/** Сборка «+n»: прежняя — «+n−1»; версия каталога — null. */
export function prevBuild(v: string | null | undefined): string | null {
  const m = /^(.+)\+(\d+)$/.exec(v ?? "");
  return m && Number(m[2]) > 1 ? `${m[1]}+${Number(m[2]) - 1}` : null;
}
export const short = (v: string) => (v.includes("+") ? `+${v.split("+")[1]}` : v);

const listed = (d: ReleaseData): Listed | null => okOf<Listed>(d.list) ?? null;

export const planOf = (d: ReleaseData, m: string): Record<string, Entry> => listed(d)?.machines.find((x) => x.machine === m)?.plan ?? {};
export const stableOf = (d: ReleaseData, part: string): string | null => listed(d)?.parts[part]?.stable ?? null;

/** Последние номера части, кроме stable, новые первыми (до n). */
export function versionsOf(d: ReleaseData, part: string, n: number): string[] {
  const st = stableOf(d, part);
  return (listed(d)?.parts[part]?.versions ?? []).filter((v) => v !== st).reverse().slice(0, n);
}

/** Ячейка матрицы: что стоит на машине против того, что ей велено (закрепление плана, иначе stable). */
export function cellOf(d: ReleaseData, m: string, part: string): Cell | null {
  const st = d.kst[m];
  const pe = planOf(d, m)[part];
  const pin = pe?.pin;
  const want = pin ?? stableOf(d, part);
  const online = d.online.includes(m);
  const ok = okOf<KState>(st);
  const kp = ok ? (part === "keeper" && ok.keeper ? { part, version: ok.keeper, state: "running", error: undefined } : ok.parts?.find((x) => x.part === part)) : undefined;
  if (!online || !ok) return kp || pe || want ? { k: "gone", t: kp?.version ?? want ?? "—", pin } : null;
  if (!kp && !pe) return null;
  if (pe?.on === false) return { k: "off", t: "выключена", pin };
  if (kp?.state === "failed") return { k: "fail", t: `${kp.version ?? "?"} · сбой`, pin, why: kp.error };
  if (kp?.version && want && kp.version !== want) return { k: kp.state === "starting" || kp.state === "updating" ? "upd" : "behind", t: `${kp.version} → ${want}`, pin };
  return { k: "ok", t: kp?.version ?? want ?? "—", pin };
}

/** Части машин: из каталога и из ответов keeper'ов; host и keeper — первыми. */
export function machineParts(d: ReleaseData): string[] {
  const fromList = Object.entries(listed(d)?.parts ?? {}).filter(([, p]) => p.where === "machine").map(([n]) => n);
  const seen = Object.values(d.kst).flatMap((s) => (okOf<KState>(s)?.parts ?? []).map((p) => p.part));
  const rank = (p: string) => (p === "host" ? 0 : p === "keeper" ? 1 : 2);
  return [...new Set([...fromList, ...seen])].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/** Машины матрицы: на связи и те, у кого есть план. */
export const relMachines = (d: ReleaseData, hosts: readonly string[]): string[] => [...new Set([...d.online, ...hosts])].sort();
