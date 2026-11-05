// Карта модулей для сноса: размер, контракт и связи — из манифестов и git.
// Без аргументов — все модули. --boundary a,b — контракт границы и числа по каждому соседу. Границу проводит архитектор, карта только считает.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CODE, TEST, tokensOf } from "../../../../tools/demolish/measure.ts";
import { loadRepo, ownerOf } from "../../../../tools/manifest-gate/contract.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 1 << 28 });

const mods = loadRepo(root).map((m) => ({ ...m, dir: m.dir.replaceAll("\\", "/") + "/" }));
const byName = new Map(mods.map((m) => [m.name, m]));
// вложенный модуль (экран пульта) считает своё сам: файл принадлежит самой длинной папке
const longest = [...mods].sort((a, b) => b.dir.length - a.dir.length);
const ownerOfPath = (p: string) => longest.find((m) => p.startsWith(m.dir))?.name;

const size = new Map(mods.map((m) => [m.name, { code: 0, tests: 0, commits: 0 }]));
for (const line of git("ls-files").split("\n")) {
  const name = ownerOfPath(line);
  if (!name || !CODE.test(line) || line.endsWith(".d.ts")) continue;
  const tokens = tokensOf(line, readFileSync(join(root, line), "utf8"));
  const s = size.get(name)!;
  if (TEST.test(line)) s.tests += tokens;
  else s.code += tokens;
}
for (const commit of git("log", "--no-merges", "--name-only", "--format=%x00").split("\0")) {
  const touched = new Set(commit.split("\n").filter(Boolean).map(ownerOfPath));
  for (const name of touched) if (name) size.get(name)!.commits++;
}

/** Кто пользуется именем контракта: "имя@владелец" → модули. */
const users = new Map<string, Set<string>>();
for (const m of mods) for (const ref of Object.keys(m.uses)) {
  if (!users.has(ref)) users.set(ref, new Set());
  users.get(ref)!.add(m.name);
}
const usersOf = (name: string, owner: string) => users.get(`${name}@${owner}`) ?? new Set<string>();

/** Контракт границы: входящие имена — чем пользуются снаружи; ничьи — никто в манифестах; внутренние умирают при сносе; исходящие — чем пользуется граница. */
function contract(inside: Set<string>) {
  const incoming: string[] = [], orphan: string[] = [], inner: string[] = [];
  const outgoing = new Set<string>();
  for (const name of inside) {
    const m = byName.get(name)!;
    for (const p of Object.keys(m.provides)) {
      const u = [...usersOf(p, name)];
      if (!u.length) orphan.push(`${p}@${name}`);
      else if (u.every((x) => inside.has(x))) inner.push(`${p}@${name}`);
      else incoming.push(`${p}@${name}`);
    }
    for (const ref of Object.keys(m.uses)) if (!inside.has(ownerOf(ref))) outgoing.add(ref);
  }
  return { incoming, orphan, inner, outgoing: [...outgoing], width: incoming.length + orphan.length + outgoing.size };
}

function table(rows: (string | number)[][]) {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)));
  for (const r of rows) console.log(r.map((c, i) => (typeof c === "number" ? String(c).padStart(widths[i]) : String(c).padEnd(widths[i]))).join("  "));
}
const sum = (names: Iterable<string>, key: "code" | "tests" | "commits") => [...names].reduce((n, x) => n + size.get(x)![key], 0);

const flag = process.argv.indexOf("--boundary");
if (flag < 0) {
  const rows = mods.map((m) => {
    const c = contract(new Set([m.name]));
    const s = size.get(m.name)!;
    const consumers = new Set(Object.keys(m.provides).flatMap((p) => [...usersOf(p, m.name)]));
    return [m.name, m.type, s.code, s.tests, s.commits, c.incoming.length, c.orphan.length, c.outgoing.length, consumers.size] as (string | number)[];
  }).sort((a, b) => (b[2] as number) - (a[2] as number));
  table([["модуль", "тип", "код", "тесты", "коммиты", "вход", "ничьи", "выход", "потребители"], ...rows]);
} else {
  const names = process.argv[flag + 1]?.split(",") ?? [];
  const unknown = names.filter((n) => !byName.has(n));
  if (!names.length || unknown.length) {
    console.error(`неизвестные модули: ${unknown.join(", ") || "список пуст"}`);
    process.exit(1);
  }
  const inside = new Set(names);
  const c = contract(inside);
  const apart = names.reduce((n, x) => n + contract(new Set([x])).width, 0);
  console.log(`граница: ${names.join(", ")}`);
  console.log(`код ${sum(inside, "code")} · тесты ${sum(inside, "tests")} · коммиты ${sum(inside, "commits")}`);
  console.log(`ширина контракта ${c.width} (порознь ${apart}): вход ${c.incoming.length} · ничьи ${c.orphan.length} · выход ${c.outgoing.length} · внутренних умирает ${c.inner.length}`);
  for (const [title, list] of [["вход (держать)", c.incoming], ["ничьи (искать потребителя вне манифестов)", c.orphan], ["выход", c.outgoing], ["умирает", c.inner]] as const) {
    if (list.length) console.log(`\n${title}:\n  ${list.join("\n  ")}`);
  }
  // соседи: умирает — имена, которые перестанут быть контрактом; чужие — потребители соседа вне границы
  const neighbours = new Set<string>();
  for (const n of inside) {
    for (const ref of Object.keys(byName.get(n)!.uses)) neighbours.add(ownerOf(ref));
    for (const p of Object.keys(byName.get(n)!.provides)) for (const u of usersOf(p, n)) neighbours.add(u);
  }
  const rows = [...neighbours].filter((n) => byName.has(n) && !inside.has(n)).map((n) => {
    const withIt = new Set([...inside, n]);
    const after = contract(withIt);
    const foreign = new Set(Object.keys(byName.get(n)!.provides).flatMap((p) => [...usersOf(p, n)]).filter((u) => !withIt.has(u)));
    return [n, after.inner.length - c.inner.length, foreign.size, after.width - c.width, size.get(n)!.code, size.get(n)!.commits] as (string | number)[];
  }).sort((a, b) => (b[1] as number) - (a[1] as number) || (a[2] as number) - (b[2] as number));
  console.log("");
  table([["сосед", "умирает", "чужие", "Δширины", "код", "коммиты"], ...rows]);
}
