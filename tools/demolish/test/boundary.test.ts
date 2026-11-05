// Леса инструментов сноса: команды на временном репо, вход — командная строка, исход — вывод и файлы.
// Браузерная часть (shots-pair и снятие деревьев) проверяется настоящими снимками: npm run shots.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const CLI = fileURLToPath(new URL("../cli.ts", import.meta.url));
const CMD_MS = 60_000;
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "demolish-"));
  dirs.push(dir);
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: dir, encoding: "utf8" }).trim();
  const put = (path: string, text: string) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  const commit = (message: string) => {
    git("add", ".");
    git("commit", "-q", "-m", message);
    return git("rev-parse", "HEAD");
  };
  git("init", "-q");
  const run = (...a: string[]) => {
    const r = spawnSync(process.execPath, [CLI, ...a], { cwd: dir, encoding: "utf8", timeout: CMD_MS });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  return { dir, put, commit, run };
}

const OLD = `export function route(a, b) {
  if (a && b) return "оба";
  for (const x of a) if (x) return x;
  return b ? "wire-format-v1" : "нет";
}
`;
const NEW = `export const route = (a) => a[0] ?? "нет";
`;
const TEST_OLD = `it("один", () => {});\nit("два", () => {});\n`;
const TEST_NEW = `it("один", () => {});\n`;

describe("size", () => {
  it("токены, сложность и случаи до и после; десять худших называют функцию; код и тесты считаются порознь", () => {
    const r = repo();
    r.put("m/src/a.ts", OLD);
    r.put("m/test/a.test.ts", TEST_OLD);
    const before = r.commit("старый");
    r.put("m/src/a.ts", NEW);
    r.put("m/test/a.test.ts", TEST_NEW);
    const after = r.commit("новый");
    const { code, out } = r.run("size", before, after, "m");
    expect(code).toBe(0);
    expect(out).toContain("сложность: 6 → 2 (-67 %)");
    expect(out).toContain("случаи тестов: 2 → 1 (-50 %)");
    expect(out).toContain("строки тестов: 2 → 1");
    expect(out).toMatch(/токены кода: (\d+) → (\d+) \(-\d+ %\)/);
    expect(out).toContain("6 · 5 строк · route · m/src/a.ts");
  });

  it("Go считается своей мерой: ветвления функции, Test-функция — случай", () => {
    const r = repo();
    const before = (r.put("k/a.go", "package k\n"), r.commit("пусто"));
    r.put("k/a.go", "package k\nfunc Run(a bool) int {\n\tif a && true {\n\t\treturn 1\n\t}\n\treturn 0\n}\n");
    r.put("k/a_test.go", "package k\nfunc TestRun(t *T) {}\n");
    const { out } = r.run("size", before, r.commit("go"), "k");
    expect(out).toContain("сложность: 0 → 3");
    expect(out).toContain("случаи тестов: 0 → 1");
  });
});

describe("lost", () => {
  it("называет пропавшие строку и литерал, а совпавшие и комментарии — нет; тесты не смотрит", () => {
    const r = repo();
    r.put("m/src/a.ts", `// комментарий старого кода\nconst keep = "остался";\n${OLD}`);
    r.put("m/test/a.test.ts", `const t = "литерал теста";\n`);
    const before = r.commit("старый");
    r.put("m/src/a.ts", `const keep = "остался";\n${NEW}`);
    r.put("m/test/a.test.ts", "");
    r.commit("новый");
    const { code, out } = r.run("lost", before, "m");
    expect(code).toBe(0);
    expect(out).toContain("wire-format-v1");
    expect(out).toContain("if (a && b)");
    expect(out).not.toContain("остался");
    expect(out).not.toContain("комментарий старого кода");
    expect(out).not.toContain("литерал теста");
    expect(out).toMatch(/пропало [1-9]/);
  });

  it("--comments: только комментарии старого кода, которых нет в новом: причина правила живёт в них", () => {
    const r = repo();
    r.put("m/src/a.go", `// остановка доводит начатое
// общий комментарий
func a() {}
`);
    r.put("m/src/b.ts", `/**
 * ссылка могла истечь
 */
export const b = "литерал";
`);
    const before = r.commit("старый");
    r.put("m/src/a.go", `// общий комментарий
func a() { x() }
`);
    r.put("m/src/b.ts", `export const c = 1;
`);
    r.commit("новый");
    const { code, out } = r.run("lost", before, "--comments", "m");
    expect(code).toBe(0);
    expect(out).toContain("остановка доводит начатое");
    expect(out).toContain("ссылка могла истечь");
    expect(out).not.toContain("общий комментарий");
    expect(out).not.toContain("литерал");
    expect(out).not.toContain("func a");
  });
});

describe("dom-diff", () => {
  it("равное с точностью до времени и пустого style — совпало; разница, порядок и пропавший экран названы; --nosize снимает размеры", () => {
    const r = repo();
    const put = (name: string, trees: Record<string, string>) => r.put(name, JSON.stringify(trees));
    put("old.json", { same: `<a style=""> [1x1@0,0]\n"12:30"`, moved: "<a>\n<b>", changed: "<a>\n<c>", gone: "<a>", sized: "<a> [1x1@0,0]" });
    put("new.json", { same: `<a> [1x1@0,0]\n"18:45"`, moved: "<b>\n<a>", changed: "<a>\n<d>", sized: "<a> [9x9@5,5]" });
    const { code, out } = r.run("dom-diff", "old.json", "new.json");
    expect(code).toBe(0);
    expect(out).toContain("--- gone: нет на новом");
    expect(out).toContain("--- moved: убрано 0, добавлено 0, порядок другой");
    expect(out).toContain("--- changed: убрано 1, добавлено 1");
    expect(out).toContain("  - <c>");
    expect(out).toContain("  + <d>");
    expect(out).toContain("--- sized");
    expect(out).toContain("экранов 5, совпало 1");
    expect(r.run("dom-diff", "old.json", "new.json", "sized", "--nosize").out).toContain("экранов 1, совпало 1");
  });
});

describe("mutate", () => {
  it("упавшая команда — убит, прошедшая — выжил; файл возвращён; строки нет — отказ словом", () => {
    const r = repo();
    r.put("a.txt", "alpha beta");
    const fails = `node -e "process.exit(require('fs').readFileSync('a.txt','utf8').includes('ALPHA')?1:0)"`;
    r.put("t.json", JSON.stringify([{ file: "a.txt", from: "alpha", to: "ALPHA" }, { file: "a.txt", from: "beta", to: "BETA" }]));
    const { code, out } = r.run("mutate", "t.json", "--", fails);
    expect(code).toBe(0);
    expect(out).toContain("убит · a.txt: alpha → ALPHA");
    expect(out).toContain("выжил · a.txt: beta → BETA");
    expect(out).toContain("мутантов 2, выжило 1");
    expect(readFileSync(join(r.dir, "a.txt"), "utf8")).toBe("alpha beta");
    r.put("bad.json", JSON.stringify([{ file: "a.txt", from: "нет такого", to: "x" }]));
    const bad = r.run("mutate", "bad.json", "--", fails);
    expect(bad.code).toBe(2);
    expect(bad.err).toContain("не один раз или нет");
  });
});
