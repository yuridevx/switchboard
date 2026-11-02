// Тесты relay: проект relay — настоящие объекты relay в workerd (miniflare), gate — настоящий,
// по привязке, со своей базой D1 стенда (GATE_DB — та же база для теста); участники — маленькие поддельные Worker. Проект link — клиент link в Node.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";

const here = dirname(fileURLToPath(import.meta.url));
export const TEST_SECRET = "test-secret";

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

function participant(name: string, contract: Record<string, number>, uses?: Record<string, number>) {
  return {
    name: `switchboard-${name}`,
    modules: true,
    script: fixture("participant.js"),
    compatibilityDate: "2026-08-01",
    bindings: { NAME: name, CONTRACT: contract, ...(uses ? { USES: uses } : {}) },
  };
}

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
                  serviceBindings: {
                    REAL: { name: "gate-real", entrypoint: "Gate" },
                    NOSECRET: { name: "gate-nosecret", entrypoint: "Gate" },
                  },
                },
                {
                  name: "gate-real",
                  modules: true,
                  script: gateScript(),
                  compatibilityDate: "2026-08-01",
                  d1Databases: { DB: "gate-db" },
                  bindings: { FLEET_SECRET: TEST_SECRET, REVOKED: ["client.phone.k2a9"], OWNER: "owner@example.com" },
                },
                {
                  name: "gate-nosecret",
                  modules: true,
                  script: gateScript(),
                  compatibilityDate: "2026-08-01",
                  d1Databases: { DB: "gate-db" },
                  bindings: { REVOKED: [], OWNER: "owner@example.com" },
                },
                participant("push", { "push.key": 1, "push.send": 1, "push.subscribe": 1 }),
                participant("ledger", { "ledger.add": 1, "ledger.read": 1 }),
                participant("audit", { "audit.log": 1 }),
                participant("echo", { "echo.ping": 1 }),
              ],
            },
          }),
        ],
        test: { name: "relay", include: ["test/relay*.test.ts"], testTimeout: 15_000 },
      },
      {
        test: { name: "link", environment: "node", include: ["test/link*.test.ts"] },
      },
    ],
  },
});
