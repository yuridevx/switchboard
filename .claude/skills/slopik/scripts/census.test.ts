// Конвейер слопиков на своём входе: временный репо и каталог состояния. Запуск: node --test census.test.ts
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, it } from "node:test";
import { census, fate, pass, stop } from "./census.ts";

let root = "";
const git = (...a: string[]) => execFileSync("git", a, { cwd: root, encoding: "utf8" }).trim();
const put = (file: string, text: string) => {
  mkdirSync(join(root, file, ".."), { recursive: true });
  writeFileSync(join(root, file), text);
};
const module_ = (dir: string, name: string) => put(`${dir}/module.json`, JSON.stringify({ name, type: "worker", version: "1.0.0", provides: {}, uses: {}, config: {} }));
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
  module_("workers/a", "a");
  module_("workers/b", "b");
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

const snap = (near: Array<[string, string]>, small = 10, config = "c") => ({ sha: "s", config, functions: 100, small, near: near.map(([ka, kb]) => ({ ka, kb, j: 0.8, toks: 50 })), inside: [] });

it("ушедшая пара с живыми символами идёт на чтение, настоящая сводка — нет", () => {
  const f = fate(snap([["m:live", "n:live2"], ["m:dead", "n:dead2"]]), snap([]), (k) => k.includes("live"));
  assert.deepEqual(f.read, ["m:live = n:live2"]);
  assert.deepEqual(f.gone, ["m:dead = n:dead2"]);
  assert.ok(f.signs.some((s) => s.includes("оба символа живы")));
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
