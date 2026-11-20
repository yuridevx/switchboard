// Эталоны правила сборки «проверка не ждёт времени сама»: node tools/test/run.mjs tools
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { check } from "./gate.mjs";

/** Дерево репо во временной папке: файлы по относительным путям. */
function tree(files) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "sb2-gate-"));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(base, rel)), { recursive: true });
    fs.writeFileSync(path.join(base, rel), text);
  }
  return base;
}

// чьё: устав — гейт проверяет устройство кода; дизайн «Тесты без случайности», эталон «Таймер в тесте»
test("таймер в проверке: подложенный вызов таймера и своё число предела — правило красное и называет файл и строку", () => {
  const base = tree({
    "tools/fleet/live-x.mjs": ['import { check } from "./harness.mjs";', "await check(async (t) => {", "  await new Promise((r) => setTimeout(r, 100));", "  await page.waitForTimeout(3000);", "  await page.locator(\"nav\").waitFor({ timeout: 8000 });", "});", ""].join("\n"),
    "tools/fleet/smoke.ts": "const r: Response = await fetch(url, { signal: AbortSignal.timeout(60_000) });\n",
  });
  assert.deepEqual(check(base), [
    "tools/fleet/live-x.mjs:3: таймер в проверке (setTimeout) — ждите сигнал через обвязку",
    "tools/fleet/live-x.mjs:4: таймер в проверке (page.waitForTimeout) — ждите сигнал через обвязку",
    "tools/fleet/live-x.mjs:5: своё число предела (timeout: 8000) — предел один, бюджет обвязки",
    "tools/fleet/smoke.ts:1: таймер в проверке (AbortSignal.timeout) — ждите сигнал через обвязку",
  ]);
  fs.rmSync(base, { recursive: true, force: true });
});

// чьё: код — таймер у обвязки и её эталонов законен; слово «setTimeout» в тексте сценария — не вызов
test("обвязка и текст не в счёт: таймер в обвязке, слово в строке сценария и ожидание без числа правило не трогают", () => {
  const base = tree({
    "tools/fleet/harness.mjs": "export const realClock = { setTimeout: (fn, ms) => setTimeout(fn, ms) };\n",
    "tools/fleet/harness.test.mjs": "await new Promise((r) => setTimeout(r, 5));\n",
    "tools/fleet/live-y.mjs": ['const command = \'node -e "setTimeout(() => console.log(1), 30000)"\';', "await page.locator(\"nav\").waitFor();", "await t.wait(\"файл на диске\", () => read());", ""].join("\n"),
  });
  assert.deepEqual(check(base), []);
  fs.rmSync(base, { recursive: true, force: true });
});

// чьё: дизайн «Тесты без случайности» — тест части не ждёт времени сам: таймер — у стенда, моков и часов теста;
// поле timeout в данных запроса или сценария — данные (host/test/iter1.test.ts, web/src/session/screens.test.tsx), а не ожидание
test("тест части: настоящий таймер и предел ожидания — красные; стенд, мок, часы теста и поле timeout в данных — нет", () => {
  const base = tree({
    "host/test/x.test.ts": ["await new Promise((r) => setTimeout(r, 50));", 'await call("shell.run", { script: "x", timeout: 1, wait: 40 });', ""].join("\n"),
    "web/src/y.test.tsx": ["await vi.waitFor(() => seen(), { timeout: 500 });", 'const step = { tool: "Bash", input: { command: "ls", timeout: 5 } };', ""].join("\n"),
    "platform/src/z.test.ts": "const s = AbortSignal.timeout(1000);\n",
    "host/stand/clock.ts": "export const real = (fn, ms) => setTimeout(fn, ms);\n",
    "platform/test/kit.ts": "setTimeout(() => reject(new Error('кадр не пришёл')), ms);\n",
    "services/test/stand.ts": "setInterval(tick, 10);\n",
    "web/src/mock/fleet.ts": "setTimeout(push, 0);\n",
    "web/src/test-clock.ts": "export const later = (fn) => setTimeout(fn, 0);\n",
  });
  assert.deepEqual(check(base), [
    "platform/src/z.test.ts:1: таймер в тесте (AbortSignal.timeout) — ждите сигнал или часы теста",
    "host/test/x.test.ts:1: таймер в тесте (setTimeout) — ждите сигнал или часы теста",
    "web/src/y.test.tsx:1: своё число предела (timeout: 500) — ждите сигнал или часы теста",
  ]);
  fs.rmSync(base, { recursive: true, force: true });
});
