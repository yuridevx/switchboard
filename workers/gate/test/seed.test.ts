// Эталон 5013, инструмент: seed — инструкция в вывод, приглашение в поток ошибок.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SEED = join(dirname(fileURLToPath(import.meta.url)), "..", "seed.ts");
const run = (args: string[]) => spawnSync(process.execPath, [SEED, ...args], { encoding: "utf8" });

describe("seed", () => {
  it("5013 · seed host laptop → инструкция вставки «ждёт приёма» с хэшем в выводе, приглашение — в поток ошибок; секрета в выводе нет", () => {
    const r = run(["host", "laptop"]);
    expect(r.status).toBe(0);
    const inv = r.stderr.trim();
    expect(inv).toMatch(/^[a-z0-9]{4}\.[A-Za-z0-9_-]{43}$/);
    const [kid, code] = inv.split(".");
    expect(r.stdout.startsWith(`INSERT INTO passes (id, role, name, person, state, hash, by, at) VALUES ('${kid}', 'host', 'laptop', NULL, 'wait', '`)).toBe(true);
    expect(r.stdout).toMatch(/'[0-9a-f]{64}', 'seed', \d+\);\n$/);
    expect(r.stdout).not.toContain(code);
  });

  it("seed без имени или client без почты — выход 2 с использованием", () => {
    expect(run(["host"]).status).toBe(2);
    expect(run(["client", "phone"]).status).toBe(2);
    expect(run(["client", "phone", "x@y"]).status).toBe(0);
  });
});
