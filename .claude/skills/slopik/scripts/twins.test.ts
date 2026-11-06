// Счётчик близнецов на временном репо: настоящий scan.mjs, настоящие снимки в SLOPIK_HOME. Запуск: node --test twins.test.ts
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, it } from "node:test";
import { fileURLToPath } from "node:url";
import { journalFile, load, pass, stop, type Snapshot } from "./census.ts";
import { count } from "./twins.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..", "..");
let root = "";
let clock = 0;
const git = (...a: string[]) => execFileSync("git", a, { cwd: root, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_DATE: `${clock} +0000`, GIT_COMMITTER_DATE: `${clock} +0000` } }).trim();
const put = (file: string, text: string) => {
  mkdirSync(join(root, file, ".."), { recursive: true });
  writeFileSync(join(root, file), text);
};
/** Новая задача: два часа после прошлого коммита. Той же задаче — минута. */
const commit = (gap = 7200) => {
  clock += gap;
  git("add", ".");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "x");
  return git("rev-parse", "HEAD");
};

const STEPS = ["const id = frame.id;", 'if (typeof id !== "string") return fail(id, "bad_id");', 'const limit = Number(frame.limit ?? 10);', "if (limit > 100) return fail(id, 'too_many');", 'const out = await run(frame.kind, limit);', 'log("served", frame.kind, out.length);', "return done(id, out);"];
const fn = (name: string, extra = "", body = STEPS) => `export async function ${name}(frame: Frame): Promise<Reply> {\n  ${[...body.slice(0, 2), ...(extra ? [extra] : []), ...body.slice(2)].join("\n  ")}\n}\n`;
const A = "workers/a/src/index.ts";
const B = "workers/b/src/index.ts";

/** Снимок настоящим детектором: файл pairs-<имя>.json, как его пишет census snapshot. */
const snap = (name: string): Snapshot => {
  const out = join(root, ".state", `scan-${name}.txt`);
  execFileSync("node", [join(here, "scan.mjs"), root, out], { cwd: repo, stdio: "pipe", env: { ...process.env, SLOPIK_HOUSES: JSON.stringify([{ name: "a", dir: "workers/a/" }, { name: "b", dir: "workers/b/" }, { name: "c", dir: "workers/c/" }]) } });
  const s = { sha: git("rev-parse", "HEAD"), config: "c", ...JSON.parse(readFileSync(`${out}.json`, "utf8")) };
  writeFileSync(join(root, ".state", `pairs-${name}.json`), JSON.stringify(s));
  return load(name);
};
const twins = (a = "до", b = "после") => count(root, load(a), load(b));

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "twins-"));
  process.env.SLOPIK_HOME = join(root, ".state");
  mkdirSync(join(root, ".state"));
  clock = 1_700_000_000;
  git("init", "-q");
  git("config", "core.autocrlf", "false");
  put(".gitignore", ".state\n");
  put(A, fn("serve"));
  put(B, fn("answer"));
  commit();
  assert.equal(snap("до").near.length, 1);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

it("комментарий, тип и локальное имя — не правка: пара стоит", () => {
  put(A, fn("serve").replace("const id = frame.id;", "// кадр\n  const key: string = frame.id as string;").replaceAll("id,", "key,").replace("typeof id", "typeof key"));
  commit();
  snap("после");
  const row = twins();
  assert.equal(row.moved, 0);
  assert.equal(row.diverged + row.late + row.closer, 0);
});

it("строка поведения в одной стороне без второй — расхождение", () => {
  put(A, fn("serve", 'if (frame.reply) return null;'));
  const c = commit();
  snap("после");
  const row = twins();
  assert.equal(row.moved, 1);
  assert.equal(row.diverged, 1);
  assert.deepEqual(row.forgotten, [{ kind: "diverged", edited: "a:serve", other: "b:answer", commit: c, late: undefined }]);
});

it("обе стороны в одной задаче — синхронно, близнеца нет", () => {
  put(A, fn("serve", 'if (frame.reply) return null;'));
  commit();
  put(B, fn("answer", 'if (frame.reply) return null;'));
  commit(60);
  snap("после");
  const row = twins();
  assert.equal(row.sync, 1);
  assert.equal(row.late + row.diverged, 0);
});

it("такая же правка второй стороны в другой задаче — поздняя пропагация с обоими коммитами", () => {
  put(A, fn("serve", 'if (frame.reply) return null;'));
  const first = commit();
  put("workers/c/src/other.ts", "export const other = 1;\n");
  commit(); // отрезок режет разрыв, а не соседний файл
  put(B, fn("answer", 'if (frame.reply) return null;'));
  const second = commit();
  snap("после");
  const row = twins();
  assert.equal(row.late, 1);
  assert.equal(row.diverged, 0);
  assert.deepEqual(row.forgotten, [{ kind: "late", edited: "a:serve", other: "b:answer", commit: first, late: second }]);
});

it("другая правка второй стороны — не пропагация: две разных односторонних", () => {
  put(A, fn("serve", 'if (frame.reply) return null;'));
  commit();
  put(B, fn("answer", 'audit(frame.kind, "ledger", 42);'));
  commit();
  snap("после");
  const row = twins();
  assert.equal(row.late, 0);
  assert.equal(row.diverged, 2);
});

it("сторона догоняет близнеца — сближение, в забытых не считается", () => {
  put(B, fn("answer", 'if (frame.reply) return null;'));
  commit();
  snap("старт");
  put(A, fn("serve", 'if (frame.reply) return null;'));
  commit();
  snap("после");
  const row = twins("старт", "после");
  assert.equal(row.closer, 1);
  assert.deepEqual(row.forgotten, []);
});

it("массовый коммит и слияние правку не дают, слежение идёт дальше", () => {
  put(A, fn("serve", 'if (frame.reply) return null;'));
  for (let i = 0; i < 13; i++) put(`workers/c/src/f${i}.ts`, `export const v${i} = ${i};\n`);
  commit();
  const trunk = git("rev-parse", "--abbrev-ref", "HEAD");
  git("checkout", "-qb", "side");
  put(B, fn("answer", 'if (frame.kind) return null;'));
  commit();
  git("checkout", "-q", trunk);
  put("workers/c/src/g.ts", "export const g = 1;\n");
  commit();
  clock += 60;
  git("-c", "user.name=t", "-c", "user.email=t@t", "merge", "-q", "--no-edit", "side");
  put(A, fn("serve", 'if (frame.reply) return false;'));
  commit();
  snap("после");
  const row = twins();
  assert.equal(row.mass, 1);
  assert.equal(row.merges, 1);
  // ветка B подтянулась к массовой правке A — сближение; правка A после слияния — расхождение. Массовая и слияние не посчитаны
  assert.equal(row.closer, 1);
  assert.equal(row.diverged, 1);
});

it("функция переехала в другой файл — слежение идёт за ней", () => {
  rmSync(join(root, A));
  put("workers/a/src/door.ts", fn("serve"));
  commit();
  put("workers/a/src/door.ts", fn("serve", 'if (frame.reply) return null;'));
  const c = commit();
  snap("после");
  const row = twins();
  assert.equal(row.broken, 0);
  assert.equal(row.forgotten[0].commit, c);
});

it("функцию заменили новой — перепись, не забытый близнец; без второй стороны — связь порвана", () => {
  put(A, "export async function serve(frame: Frame) {\n  for (const part of frame.parts) await write(part);\n  const seen = new Set(frame.parts.map((p) => p.key));\n  while (seen.size) seen.delete([...seen][0]);\n  return { ok: true, count: frame.parts.length, at: Date.now(), tail: frame.tail ?? null };\n}\n");
  commit();
  put(B, "export const gone = 1;\n");
  commit();
  snap("после");
  const row = twins();
  assert.equal(row.rewrites, 1);
  assert.equal(row.broken, 1);
  assert.deepEqual(row.forgotten, []);
});

it("строка счётчика в журнале не сбивает остановку цикла", () => {
  pass({ confirmed: 0, rejected: 1, queue: 3 }, "x");
  put(A, fn("serve", 'if (frame.reply) return null;'));
  commit();
  snap("после");
  twins();
  const rows = readFileSync(journalFile(), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(rows.at(-1).kind, "twins");
  assert.equal(rows.at(-1).diverged, 1);
  assert.deepEqual(stop(), { go: false, why: "проход не дал подтверждённых находок" });
});
