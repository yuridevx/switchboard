// Тесты gate: проект gate — Worker в workerd (miniflare) с базой D1 стенда и стендом для соседей; проект cli — инструменты настоящими процессами в Node.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { gateStand } from "./contract.ts";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const migrations = await readD1Migrations(here("./migrations"));
// настоящий вывод seed: Worker проверяет инструкцию и приглашение целиком
const seeded = spawnSync(process.execPath, [here("./seed.ts"), "host", "first"], { encoding: "utf8", timeout: 30_000 });
const seed = { sql: seeded.stdout, invite: seeded.stderr.trim() };

export default defineConfig({
  test: {
    projects: [
      {
        plugins: [
          cloudflareTest({
            wrangler: { configPath: "./wrangler.jsonc" },
            miniflare: {
              bindings: { TEST_MIGRATIONS: migrations, TEST_SEED: seed },
              workers: [{ ...gateStand(), name: "gate-stand" }],
              serviceBindings: { STAND: { name: "gate-stand", entrypoint: "Gate" } },
            },
          }),
        ],
        test: { name: "gate", include: ["test/boundary.test.ts"] },
      },
      { test: { name: "cli", environment: "node", include: ["test/boundary-cli.test.ts"] } },
    ],
  },
});
