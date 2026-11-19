// Эталон выкладки служб: node tools/test/run.mjs tools
// Путь, который Worker служб разбирает сам, стоит в списке «сначала Worker» его конфигурации: без строки в списке запрос уходит
// в раздачу файлов страницы. чьё: факт — 19 нояб. 2026 путь /h/* без строки в списке: POST на адрес с секретом получал 405.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("пути Worker'а служб стоят в списке «сначала Worker»", () => {
  const code = fs.readFileSync(path.join(root, "services/src/index.ts"), "utf8");
  const exact = [...code.matchAll(/pathname === "([^"]+)"/g)].map((m) => m[1]);
  const prefixes = [...code.matchAll(/pathname\.startsWith\("([^"]+)"\)/g)].map((m) => m[1] + "*");
  const list = JSON.parse(/"run_worker_first":\s*(\[[^\]]*\])/.exec(fs.readFileSync(path.join(root, "services/wrangler.jsonc"), "utf8"))[1]);
  assert.ok(exact.length >= 5 && prefixes.length >= 5, `пути входа не найдены в коде: ${exact.length} точных, ${prefixes.length} по началу`);
  assert.deepEqual([...exact, ...prefixes].filter((p) => !list.includes(p)), []);
});
