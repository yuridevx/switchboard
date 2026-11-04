// Предел процесса сборки: настоящий дочерний процесс. Источник: слово пользователя 2 нояб. «у всех операций должен быть лимит».
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { run } from "../src/spawn.ts";

it("процесс держит ввод и не выходит — за предел снят, вывод и причина в ответе", async () => {
  const r = await run(process.execPath, ["-e", "console.log('работаю'); setInterval(() => {}, 1000)"], tmpdir(), { limitMs: 1500 });
  expect(r.code).not.toBe(0);
  expect(r.out).toContain("работаю");
  expect(r.out).toContain("не завершился за 1.5 с");
}, 15_000);

it("обычный выход — код и вывод", async () => {
  expect(await run(process.execPath, ["-e", "console.error('x'); process.exit(3)"], tmpdir())).toEqual({ code: 3, out: "x\n" });
});
