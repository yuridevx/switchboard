// Конвейер слопиков на своём входе: временный репо и каталог состояния. Запуск: node --test census.test.ts
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, it } from "node:test";
import { census, fate, pass, stop, traces } from "./census.ts";

let root = "";
const git = (...a: string[]) => execFileSync("git", a, { cwd: root, encoding: "utf8" }).trim();
const put = (file: string, text: string) => {
  mkdirSync(join(root, file, ".."), { recursive: true });
  writeFileSync(join(root, file), text);
};
const commit = () => {
  git("add", ".");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "x");
  return git("rev-parse", "HEAD");
};
const REGISTRY = "# Реестр\n\n## Дома\n\n| дом | дело |\n|---|---|\n| `a` | первое |\n| `ghost` | ушедшее |\n\n## Понятие → владелец\n\n| понятие | владелец | примечание | след |\n|---|---|---|---|\n| отказ | `a` | | `class Refusal` |\n";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "slopik-"));
  process.env.SLOPIK_HOME = join(root, ".state");
  git("init", "-q");
  put(".gitignore", ".state\n");
  put("houses.mjs", `console.log(JSON.stringify([{ name: "a", dir: "workers/a/" }, { name: "b", dir: "workers/b/" }]))`);
  put(".claude/slopik/config.json", JSON.stringify({ houses: "node houses.mjs" }));
  put(".claude/slopik/registry.md", REGISTRY);
  put("workers/a/src/index.ts", "export class Refusal {}\n");
  put("workers/b/src/index.ts", "export const b = 1;\n");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

it("модуль без строки рождает хозяина, строка без модуля снимается", () => {
  commit();
  const c = census(root);
  assert.deepEqual(c.born, ["b"]);
  assert.deepEqual(c.gone, ["ghost"]);
});

it("рождение и уход видны по прошлому проходу, без строк реестра", () => {
  const first = commit();
  pass({ confirmed: 1, rejected: 0, queue: 1 }, first, ["a", "b", "old"]);
  put("houses.mjs", `console.log(JSON.stringify([{ name: "a", dir: "workers/a/" }, { name: "b", dir: "workers/b/" }, { name: "new", dir: "workers/new/" }]))`);
  commit();
  const c = census(root);
  assert.deepEqual(c.born, ["new"]);
  assert.deepEqual(c.gone, ["old"]);
});

it("без события дом спит, правка будит только свой дом", () => {
  const first = commit();
  pass({ confirmed: 1, rejected: 0, queue: 1 }, first);
  assert.deepEqual(census(root).wake, []);
  put("workers/b/src/index.ts", "export const b = 2;\n");
  commit();
  assert.deepEqual(census(root).wake.map((w) => [w.house, w.why]), [["b", "правка"]]);
});

it("след понятия вне владельца будит владельца", () => {
  commit();
  put("workers/b/src/index.ts", "export class Refusal {}\n");
  commit();
  const hit = census(root).wake.find((w) => w.why === "след");
  assert.equal(hit?.house, "a");
  assert.match(hit!.detail, /workers\/b\/src\/index\.ts/);
});

it("именной без дома не забирает следующую строку файла", () => {
  put(".claude/slopik/named/летописец.md", "# Л\n\nдом:\n\n## Дело\n");
  commit();
  assert.deepEqual(census(root).orphaned, []);
});

it("именной: не рождается и не снимается переписью, его дом помечается, исчезнувший дом — вопрос человеку", () => {
  put(".claude/slopik/named/страж.md", "# Страж"+String.fromCharCode(10)+String.fromCharCode(10)+"дом: `b`, `lost`"+String.fromCharCode(10));
  commit();
  const c = census(root);
  assert.deepEqual(c.born, []);
  assert.deepEqual(c.orphaned, [{ name: "страж", house: "lost" }]);
  put("workers/b/src/index.ts", "export class Refusal {}"+String.fromCharCode(10));
  commit();
  pass({ confirmed: 1, rejected: 0, queue: 0 }, git("rev-parse", "HEAD~1"));
  assert.equal(census(root).wake.find((w) => w.why === "правка")?.named, "страж");
});

const snap = (near: Array<[string, string]>, small = 10, config = "c") => ({ sha: "s", config, functions: 100, small, near: near.map(([ka, kb]) => ({ ka, kb, j: 0.8, toks: 50 })), inside: [] });

it("ушедшая пара с живыми символами идёт на чтение, настоящая сводка — нет", () => {
  const f = fate(snap([["m:live", "n:live2"], ["m:dead", "n:dead2"]]), snap([]), (k) => k.includes("live"));
  assert.deepEqual(f.read, ["m:live = n:live2"]);
  assert.deepEqual(f.gone, ["m:dead = n:dead2"]);
  assert.ok(f.signs.some((s) => s.includes("символ жив")));
});

it("новое имя одной стороны не уводит пару от чтения", () => {
  const f = fate(snap([["m:old", "n:twin"]]), snap([]), (k) => k.includes("twin"));
  assert.deepEqual(f.read, ["m:old = n:twin"]);
});

it("оба имени новые, копия в новой папке: пару выдают литералы; настоящая сводка их снижает", () => {
  const before = { ...snap([]), near: [{ ka: "m:a", kb: "n:b", fa: "", fb: "", lits: ["Удалить насовсем"], j: 0.7, toks: 50 }] };
  const after = { ...snap([]), sha: "t" };
  const trace = (n: number) => ({ copies: (sha: string) => (sha === "s" ? 2 : n), lost: 0, control: [] });
  assert.deepEqual(fate(before, after, () => false, trace(2)).read, ["m:a = n:b"]);
  assert.deepEqual(fate(before, after, () => false, trace(1)).read, []);
});

it("снятые проверки, правка контроля и новый флаг — следы обхода, настоящая сводка их не даёт", () => {
  const f = fate({ ...snap([]), flags: [] }, { ...snap([]), flags: ["x:y:wide"] }, () => false, { copies: () => 0, lost: 3, control: [".claude/slopik/registry.md"] });
  for (const word of ["флаг", "снято проверок", "правка контроля"]) assert.ok(f.signs.some((s) => s.includes(word)));
  assert.deepEqual(fate(snap([]), snap([]), () => false, { copies: () => 0, lost: 0, control: [] }).signs, []);
});

it("следы считаются по дереву: тест без expect, правка судеб, литерал в новой папке", () => {
  put("workers/a/test/a.test.ts", "expect(1).toBe(1);\nexpect(2).toBe(2);\n");
  put(".claude/slopik/registry.md", "| a |\n");
  put("workers/a/src/x.ts", 'export const t = "Удалить насовсем";\n');
  const a = commit();
  put("workers/a/test/a.test.ts", "expect(1).toBe(1);\n");
  put(".claude/slopik/registry.md", "| b |\n");
  put("shared/y.ts", 'export const t = "Удалить насовсем";\n');
  put(".claude/slopik/books/a.md", "# a\n");
  const b = commit();
  const t = traces(root, a, b);
  assert.equal(t.lost, 1);
  assert.deepEqual(t.control, [".claude/slopik/registry.md"]);
  assert.equal(t.copies(a, ["Удалить насовсем"]), 1);
  assert.equal(t.copies(b, ["Удалить насовсем"]), 2);
});

it("смена конфигурации и рост мелких функций — следы обхода", () => {
  const f = fate(snap([["a:x", "b:y"]], 10, "c1"), snap([], 20, "c2"), () => false);
  assert.ok(f.signs.some((s) => s.includes("конфигурация")));
  assert.ok(f.signs.some((s) => s.includes("мелких функций")));
});

it("цикл идёт, пока есть подтверждённое; останавливается на пустой очереди, пустом проходе и двух отказах приёмки", () => {
  assert.equal(stop().go, true);
  pass({ confirmed: 2, rejected: 1, queue: 3 }, "a");
  assert.equal(stop().go, true);
  pass({ confirmed: 0, rejected: 2, queue: 1 }, "b");
  assert.match(stop().why, /не дал подтверждённых/);
  pass({ confirmed: 1, rejected: 0, queue: 0 }, "c");
  assert.match(stop().why, /очередь пуста/);
  pass({ confirmed: 1, rejected: 0, queue: 2, failed: 1 }, "d");
  pass({ confirmed: 1, rejected: 0, queue: 2, failed: 1 }, "e");
  assert.match(stop().why, /два прохода подряд/);
});
