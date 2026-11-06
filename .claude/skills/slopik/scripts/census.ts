// Перепись слопиков: дома, события, снимки пар, судьбы, остановка. Только читает репо.
// Состояние — вне дерева, в SLOPIK_HOME (по умолчанию ~/.slopik): метрику считает старший, слопик её не видит.
//   census.ts census [--root <repo>]        дома без хозяина и хозяева без дома, кого будить
//   census.ts snapshot <имя> [--root <repo>] снимок пар
//   census.ts fate <до> <после>              судьбы пар и следы обхода
//   census.ts pass <json>                    запись прохода в журнал
//   census.ts stop                           идти дальше или остановиться
import { execFileSync, execSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const home = () => process.env.SLOPIK_HOME ?? join(homedir(), ".slopik");
const git = (root: string, ...a: string[]) => execFileSync("git", a, { cwd: root, encoding: "utf8", maxBuffer: 1 << 28 });

/** Привязка проекта: .claude/slopik/config.json — houses: команда, печатает JSON [{name, dir}]; ignore: выражение путей вне счёта. */
export function config(root: string): { houses: string; ignore?: string } {
  return JSON.parse(readFileSync(join(root, ".claude/slopik/config.json"), "utf8"));
}
const housesOf = (root: string): Array<{ name: string; dir: string }> => JSON.parse(execSync(config(root).houses, { cwd: root, encoding: "utf8", maxBuffer: 1 << 26 }));

export type Pair = { ka: string; kb: string; fa: string; fb: string; j: number; toks: number };
export type Snapshot = { sha: string; functions: number; small: number; near: Pair[]; inside: Pair[]; config: string };
export type Wake = { house: string; why: "правка" | "след"; detail: string; named?: string };

/** Таблица markdown под заголовком → строки ячеек. */
function table(text: string, heading: string): string[][] {
  const part = text.split(`## ${heading}`)[1]?.split("\n## ")[0] ?? "";
  return part.split("\n").filter((l) => l.startsWith("|")).slice(2).map((l) => l.split("|").slice(1, -1).map((c) => c.trim()));
}

const unquote = (c: string) => c.replace(/^`|`$/g, "");

/** Реестр: дома и понятия с владельцем и следом — выражением git grep, которое находит копию правила вне владельца. */
export function registry(root: string) {
  const path = join(root, ".claude/slopik/registry.md");
  const text = existsSync(path) ? readFileSync(path, "utf8") : "";
  return {
    houses: table(text, "Дома").map(([name, phrase]) => ({ name: unquote(name), phrase })),
    concepts: table(text, "Понятие → владелец").map(([concept, owner, , sign]) => ({ concept, owner: unquote(owner), sign: sign ? unquote(sign) : "" })),
  };
}

/** Именные слопики: файл на имя в .claude/slopik/named, строка «дом: a, b» — их дома. Заводит и снимает только человек. */
export function named(root: string) {
  const dir = join(root, ".claude/slopik/named");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => {
    const houses = /^дом:\s*(.+)$/m.exec(readFileSync(join(dir, f), "utf8"))?.[1] ?? "";
    return { name: f.slice(0, -3), houses: houses.split(",").map((h) => unquote(h.trim())).filter(Boolean) };
  });
}

const stateFile = () => join(home(), "state.json");
const lastPass = (): string | null => (existsSync(stateFile()) ? JSON.parse(readFileSync(stateFile(), "utf8")).last : null);
/** Дома на момент прошлого прохода: рождение и уход видны и без строк реестра. */
const lastHouses = (): string[] | null => (existsSync(stateFile()) ? (JSON.parse(readFileSync(stateFile(), "utf8")).houses ?? null) : null);

/** Кто родился, кто ушёл, кого будить. Спящий дом без события не будится: число проходов ни на что не влияет. */
export function census(root: string) {
  const mods = housesOf(root);
  const skip = config(root).ignore;
  const ignore = skip ? new RegExp(skip) : null;
  const reg = registry(root);
  const people = named(root);
  const held = new Map(people.flatMap((p) => p.houses.map((h) => [h, p.name] as const)));
  const known = new Set([...reg.houses.map((h) => h.name), ...held.keys()]);
  const names = new Set(mods.map((m) => m.name));
  const seen = lastHouses();
  const born = mods.filter((m) => !(seen ? seen.includes(m.name) : known.has(m.name)) && !held.has(m.name)).map((m) => m.name);
  const gone = (seen ?? reg.houses.map((h) => h.name)).filter((h) => !names.has(h) && !held.has(h));
  /** Дом именного исчез: сам он не снимается, вопрос человеку. */
  const orphaned = [...held].filter(([h]) => !names.has(h)).map(([house, name]) => ({ name, house }));
  const longest = [...mods].sort((a, b) => b.dir.length - a.dir.length);
  const houseOf = (file: string) => longest.find((m) => file.startsWith(m.dir))?.name;
  const wake: Wake[] = [];
  const last = lastPass();
  if (last) {
    const touched = new Map<string, string[]>();
    for (const f of git(root, "diff", "--name-only", last, "HEAD").split("\n").filter(Boolean)) {
      const h = houseOf(f);
      if (h) touched.set(h, [...(touched.get(h) ?? []), f]);
    }
    for (const [house, files] of touched) wake.push({ house, why: "правка", detail: files.slice(0, 5).join(" ") });
  }
  for (const { concept, owner, sign } of reg.concepts) {
    if (!sign) continue;
    const hits = (() => {
      try {
        return git(root, "grep", "-lE", sign, "--", ".", ":!*.test.*", ":!*/test/*", ":!.claude").split("\n").filter((f) => f && !ignore?.test(f));
      } catch {
        return []; // git grep без совпадений выходит с кодом 1
      }
    })();
    const out = hits.filter((f) => houseOf(f) !== owner);
    if (out.length) wake.push({ house: owner, why: "след", detail: `${concept}: ${out.join(" ")}` });
  }
  for (const w of wake) if (held.has(w.house)) w.named = held.get(w.house);
  return { houses: mods.length, born, gone, orphaned, named: people, wake, last };
}

/** Снимок пар с хэшем конфигурации проверок: правка исключений видна как смена хэша. */
export function snapshot(root: string, name: string): Snapshot {
  mkdirSync(home(), { recursive: true });
  const out = join(home(), `scan-${name}.txt`);
  execFileSync("node", [join(here, "scan.mjs"), root, out], { cwd: root, stdio: "pipe", env: { ...process.env, SLOPIK_HOUSES: JSON.stringify(housesOf(root)), SLOPIK_IGNORE: config(root).ignore ?? "" } });
  const scan = JSON.parse(readFileSync(`${out}.json`, "utf8"));
  const scanner = git(root, "hash-object", join(here, "scan.mjs"), join(here, "functions.mjs")).trim().split(/\s+/).join(" ");
  const snap: Snapshot = { sha: git(root, "rev-parse", "HEAD").trim(), config: scanner, ...scan };
  writeFileSync(join(home(), `pairs-${name}.json`), JSON.stringify(snap));
  return snap;
}

const keyOf = (p: Pair) => [p.ka, p.kb].sort().join(" = ");
export const load = (name: string): Snapshot => JSON.parse(readFileSync(join(home(), `pairs-${name}.json`), "utf8"));

/**
 * Судьбы по двум снимкам. Детектор знает только «пара ушла»: была ли это настоящая сводка, решает чтение.
 * Следы обхода: сменилась конфигурация, почти-клонов меньше, а мелких функций больше, старые символы живы.
 */
export function fate(before: Snapshot, after: Snapshot, alive: (key: string) => boolean) {
  const was = new Map([...before.near, ...before.inside].map((p) => [keyOf(p), p]));
  const now = new Map([...after.near, ...after.inside].map((p) => [keyOf(p), p]));
  const left = [...was.keys()].filter((k) => !now.has(k));
  const fresh = [...now.keys()].filter((k) => !was.has(k));
  const stillThere = left.filter((k) => k.split(" = ").every(alive));
  const smallGrowth = after.small - before.small;
  return {
    left: left.length,
    gone: left.filter((k) => !stillThere.includes(k)),
    read: stillThere,
    fresh,
    signs: [
      ...(before.config !== after.config ? ["сменилась конфигурация детектора"] : []),
      ...(left.length && smallGrowth > left.length ? [`мелких функций +${smallGrowth} при ${left.length} ушедших парах`] : []),
      ...(stillThere.length ? [`${stillThere.length} пар ушло, а оба символа живы`] : []),
    ],
  };
}

type Pass = { confirmed: number; rejected: number; queue: number; waiting?: number; failed?: number };
export const journalFile = () => join(home(), "journal.jsonl");

export function pass(p: Pass, sha: string, houses?: string[]): void {
  mkdirSync(home(), { recursive: true });
  appendFileSync(journalFile(), `${JSON.stringify({ t: new Date().toISOString(), sha, ...p })}\n`);
  writeFileSync(stateFile(), JSON.stringify({ last: sha, houses }));
}

/** Остановка: файл stop в SLOPIK_HOME, очереди нет, или последний проход ничего не подтвердил, или приёмка сломалась дважды подряд. */
export function stop(): { go: boolean; why: string } {
  const rows: Pass[] = existsSync(journalFile()) ? readFileSync(journalFile(), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => !r.kind) : [];
  const [prev, last] = rows.slice(-2).length === 2 ? rows.slice(-2) : [undefined, rows.at(-1)];
  if (!last) return { go: true, why: "проходов ещё не было" };
  if (last.failed && prev?.failed) return { go: false, why: "приёмка отказала два прохода подряд: дальше решает человек" };
  if (last.queue === 0) return { go: false, why: "очередь пуста: все дома спят" };
  if (last.confirmed === 0) return { go: false, why: "проход не дал подтверждённых находок" };
  return { go: true, why: `подтверждено ${last.confirmed}, в очереди ${last.queue}` };
}

function main(argv: string[]): void {
  const [command, ...rest] = argv;
  const at = rest.indexOf("--root");
  const root = at >= 0 ? rest[at + 1] : join(here, "..", "..", "..", "..");
  const say = (x: unknown) => console.log(JSON.stringify(x, null, 1));
  if (command === "census") say(census(root));
  else if (command === "snapshot") {
    const s = snapshot(root, rest[0]);
    say({ sha: s.sha, near: s.near.length, inside: s.inside.length });
  } else if (command === "fate") {
    const defined = (key: string) => {
      const name = key.split(":").slice(1).join(":");
      if (!/^[\w$]+$/.test(name)) return true; // анонимная: снимок её не различает, читать
      try {
        return !!git(root, "grep", "-lE", `\\b${name}\\b`, "--", "workers", "host", "web", "tools", "protocol", "scripts");
      } catch {
        return false;
      }
    };
    say(fate(load(rest[0]), load(rest[1]), defined));
  } else if (command === "pass") pass(JSON.parse(rest[0]), git(root, "rev-parse", "HEAD").trim(), housesOf(root).map((h) => h.name));
  else if (command === "stop") say(stop());
  else throw new Error("census | snapshot <имя> | fate <до> <после> | pass <json> | stop");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv.slice(2));
