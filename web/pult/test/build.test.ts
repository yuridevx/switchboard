// Статика оболочки пульта: dist без модулей, адресов relay и Worker'ов и ключа флота — всё это даёт список сборки.
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const app = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(app, "dist");

describe("статика оболочки пульта", () => {
  it("4187 · dist: app.js, sw.js, статика и значки; адресов relay и Worker'ов, модулей и ключа флота нет", () => {
    // источник: дизайн «Открытый флот» (слово пользователя 2 нояб. «делай»): адресов relay в коде оболочек 0
    const r = spawnSync(process.execPath, [join(app, "build.mjs")], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(readdirSync(dist).sort()).toEqual(["_headers", "app.js", "apple-touch-icon.png", "icon-192.png", "icon-512.png", "index.html", "manifest.webmanifest", "sw.js"]);
    for (const f of ["app.js", "sw.js", "index.html"]) {
      const text = readFileSync(join(dist, f), "utf8");
      expect(text).not.toMatch(/wss:\/\/|workers\.dev|pfarm\.app/);
      expect(text).not.toMatch(/client\.[a-z-]+\.[a-z0-9]+\./);
    }
    // модули — в m/ сборки, а не в оболочке: экранов модулей в app.js нет
    expect(readFileSync(join(dist, "app.js"), "utf8")).not.toContain("Новая сессия");
    expect(readFileSync(join(dist, "index.html"), "utf8")).toContain('<script src="app.js" defer></script>');
  }, 60_000);
});
