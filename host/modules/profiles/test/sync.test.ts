// Настоящий git ОС: зависшая команда не держит очередь репозитория. Источник: устав «у всех операций лимит».
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { gitWithin } from "../src/sync.ts";

it("git завис: отказ за предел со словами, а не ожидание без конца; успевший git отвечает как обычно", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "sb-git-"));
  const started = Date.now();
  await expect(gitWithin(300)(["-c", 'alias.hang=!node -e "setTimeout(()=>{},4000)"', "hang"], { cwd, env: {} })).rejects.toThrow("git не ответил за 0.3 с");
  expect(Date.now() - started).toBeLessThan(2500);
  expect((await gitWithin(10_000)(["--version"], { cwd, env: {} })).code).toBe(0);
}, 15_000);
