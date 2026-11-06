// Юниты выпуска: то, что на стенде подделано. Команда claude из пакета SDK.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claudeCli, loadRelease } from "../src/release.ts";

describe("команда claude", () => {
  it("737 · claude нет в пакете SDK — code null со словами", async () => {
    // источник: устав «ошибки — словами»; слово — чьё: код
    expect(await claudeCli(undefined)(["--version"], {})).toEqual({ code: null, out: "claude не найден в пакете SDK" });
  });

  it("вывод и код: stdout и stderr вместе, ввод доходит", async () => {
    // чьё: код — контракт host.cli
    const r = await claudeCli(process.execPath)(["-e", "process.stdin.on('data', (d) => { process.stdout.write('ввод:' + d); process.stderr.write('ошибка'); process.exit(3); })"], process.env, "да");
    expect(r.code).toBe(3);
    expect(r.out).toContain("ввод:да");
    expect(r.out).toContain("ошибка");
  });

  it("зависшая команда: за предел убита, code null со словами — процесс не остаётся", async () => {
    // источник: слово пользователя 2 нояб. «у всех операций должен быть лимит и поддержка graceful shutdown»; опыт: logins отпускает по своему пределу, а процесс claude живёт дальше
    const r = await claudeCli(process.execPath, 300)(["-e", "setInterval(() => {}, 1000)"], process.env);
    expect(r.code).toBeNull();
    expect(r.out).toContain("claude не ответил за 0.3 с");
  }, 20_000);

  it("зависшая команда, потомок держит вывод: ответ в предел, а не с выходом потомка", async () => {
    // источник: слово пользователя 2 нояб. «у всех операций должен быть лимит»; опыт на Linux: close приходит, когда вывод закрыл и потомок. На Windows close приходит сразу
    const code = `require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], { stdio: "inherit" }); setInterval(() => {}, 1000);`;
    const started = Date.now();
    const r = await claudeCli(process.execPath, 500)(["-e", code], process.env);
    expect(r).toEqual({ code: null, out: "claude не ответил за 0.5 с" });
    expect(Date.now() - started).toBeLessThan(3000);
  }, 20_000);
});
