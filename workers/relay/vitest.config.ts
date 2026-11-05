// Тесты relay: проект relay — настоящие объекты relay в workerd (miniflare), gate — настоящий,
// по привязке, со своей базой D1 стенда (GATE_DB — та же база для теста); участники — маленькие поддельные Worker. Проект link — клиент link в Node.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";

const here = dirname(fileURLToPath(import.meta.url));
/** Настоящий gate одним ES-модулем для miniflare. */
export function gateScript(): string {
  const r = buildSync({
    entryPoints: [join(here, "..", "gate", "src", "index.ts")],
    bundle: true,
    format: "esm",
    platform: "neutral",
    external: ["cloudflare:workers"],
    write: false,
  });
  return r.outputFiles[0].text;
}

/** схема базы gate: стенд кладёт пропуска нового вида прямо в неё */
const gateMigrations = await readD1Migrations(join(here, "..", "gate", "migrations"));

const fixture = (name: string) => readFileSync(join(here, "test", "fixtures", name), "utf8");

export default defineConfig({
  test: {
    projects: [
      {
        plugins: [
          cloudflareTest({
            wrangler: { configPath: "./test/wrangler.test.jsonc" },
            miniflare: {
              d1Databases: { GATE_DB: "gate-db" },
              bindings: { GATE_MIGRATIONS: gateMigrations },
              workers: [
                {
                  name: "switchboard-gate",
                  modules: true,
                  script: fixture("gate-proxy.js"),
                  compatibilityDate: "2026-08-01",
                  serviceBindings: { REAL: { name: "gate-real", entrypoint: "Gate" } },
                },
                {
                  name: "gate-real",
                  modules: true,
                  script: gateScript(),
                  compatibilityDate: "2026-08-01",
                  d1Databases: { DB: "gate-db" },
                },
                { name: "switchboard-ledger", modules: true, script: fixture("participant.js"), compatibilityDate: "2026-08-01" },
              ],
            },
          }),
        ],
        test: { name: "relay", include: ["test/boundary.test.ts"], testTimeout: 15_000 },
      },
      {
        test: { name: "link", environment: "node", include: ["test/boundary-client.test.ts"], testTimeout: 30_000 },
      },
    ],
  },
});
