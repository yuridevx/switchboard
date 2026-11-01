// Сборка пульта: dist с адресом relay из окружения, без ключа флота; RELAY_URL не wss — отказ, dist не тронут.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const app = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(app, "dist");
const build = (env: Record<string, string>) => spawnSync(process.execPath, [join(app, "build.mjs")], { env: { ...process.env, ...env }, encoding: "utf8" });

describe("сборка пульта", () => {
  it("4187 · dist: app.js, sw.js, статика и значки; адрес relay из RELAY_URL; ключа флота нет", () => {
    const r = build({ RELAY_URL: "wss://relay.example" });
    expect(r.status).toBe(0);
    expect(readdirSync(dist).sort()).toEqual(
      expect.arrayContaining(["_headers", "app.js", "apple-touch-icon.png", "icon-192.png", "icon-512.png", "index.html", "manifest.webmanifest", "sw.js"]),
    );
    for (const f of ["app.js", "sw.js"]) {
      const text = readFileSync(join(dist, f), "utf8");
      expect(text).toContain("wss://relay.example");
      expect(text).not.toMatch(/client\.[a-z-]+\.[a-z0-9]+\./);
    }
  }, 60_000);

  it("4188 · RELAY_URL не wss — выход с ошибкой словами, прежний dist на месте", () => {
    if (!existsSync(join(dist, "app.js"))) expect(build({ RELAY_URL: "wss://relay.example" }).status).toBe(0);
    const before = statSync(join(dist, "app.js")).mtimeMs;
    const r = build({ RELAY_URL: "http://x" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("RELAY_URL — нужен wss://…, а не http://x");
    expect(statSync(join(dist, "app.js")).mtimeMs).toBe(before);
  }, 60_000);
});
