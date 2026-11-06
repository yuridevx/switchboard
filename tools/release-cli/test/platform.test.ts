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
