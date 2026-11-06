// Что выпуск просит у ОС: окно процесса сборки, режим файла, выход CLI. Настоящая ОС этого не покажет на каждой машине: режим — у подделки stat, окно — у подделки spawn.
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it, vi } from "vitest";
import { entries, packModule } from "@switchboard/release";
import { run } from "../src/spawn.ts";

vi.mock("node:child_process", async (original) => {
  const real = await original<typeof import("node:child_process")>();
  return { ...real, spawn: vi.fn(real.spawn) };
});

vi.mock("node:fs", async (original) => {
  const real = await original<typeof import("node:fs")>();
  const statSync = (path: string, ...rest: []) => {
    const s = real.statSync(path, ...rest);
    return String(path).endsWith("run.sh") ? Object.assign(Object.create(s), { mode: s.mode | 0o111 }) : s;
  };
  return { ...real, statSync };
});

const tmp = () => mkdtempSync(join(tmpdir(), "switchboard-platform-"));

it("процесс сборки не открывает окно: у агента без консоли каждый npm и go мигал бы на рабочем столе (чьё: код; так запускают процессы Host)", async () => {
  await run(process.execPath, ["-e", ""], tmpdir());
  expect(vi.mocked(spawn).mock.calls.at(-1)![2]).toMatchObject({ windowsHide: true });
});

it("файл пакета с правом исполнения остаётся исполняемым: приложение ОС без dist/ запускается по app.json (чьё: код)", () => {
  const d = tmp();
  writeFileSync(join(d, "module.json"), '{"name":"d4","type":"os","version":"1.0.0"}');
  writeFileSync(join(d, "app.json"), '{"run":["./run.sh"]}');
  writeFileSync(join(d, "run.sh"), "#!/bin/sh\n");
  const modes = Object.fromEntries(entries(packModule(d).tgz).map((e) => [e.path, e.mode]));
  expect(modes).toEqual({ "module.json": 0o644, "app.json": 0o644, "run.sh": 0o755 });
});

it("предел снял сборку, потомок держит её вывод — CLI выходит с отказом и не ждёт потомка (чьё: код; опыт: npm на Windows живёт под оболочкой, снимается только оболочка)", async () => {
  const bin = tmp();
  const sleeper = `"${process.execPath}" -e "setTimeout(() => {}, 30000)"`;
  writeFileSync(join(bin, "npm.cmd"), `@${sleeper}\r\n`);
  writeFileSync(join(bin, "npm"), `#!/bin/sh\n${sleeper} &\nwait\n`, { mode: 0o755 });
  // предел CLI — 10 минут: в опыте короче
  const shorter = join(bin, "shorter.mjs");
  writeFileSync(shorter, "const real = globalThis.setTimeout;\nglobalThis.setTimeout = (fn, ms, ...rest) => real(fn, ms === 600000 ? 300 : ms, ...rest);\n");
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toLowerCase() !== "path"));
  const cli = fileURLToPath(new URL("../cli.ts", import.meta.url));
  const c = spawn(process.execPath, ["--import", pathToFileURL(shorter).href, cli, "release", "core", "--dry-run"], { env: { ...env, PATH: `${bin}${delimiter}${process.env.PATH ?? process.env.Path}` }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let err = "";
  c.stderr.on("data", (d) => (err += d));
  const code = await new Promise<number | null>((done) => {
    const late = setTimeout(() => (c.kill(), done(-1)), 15_000);
    c.on("exit", (n) => (clearTimeout(late), done(n)));
  });
  expect(err).toContain("не завершился за");
  expect(code).toBe(1);
}, 25_000);
