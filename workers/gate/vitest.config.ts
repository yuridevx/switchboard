// Тесты gate: проект gate — Worker в workerd (miniflare) с базой D1 стенда и секретом перехода; проект tools — инструменты в Node.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const migrations = await readD1Migrations(here("./migrations"));

export default defineConfig({
  test: {
    projects: [
      {
        plugins: [
          cloudflareTest({
            wrangler: { configPath: "./wrangler.jsonc" },
            miniflare: { d1Databases: ["PROD"], bindings: { FLEET_SECRET: "test-secret", REVOKED: ["client.phone.k2a9"], TEST_MIGRATIONS: migrations } },
          }),
        ],
        test: { name: "gate", include: ["test/gate.test.ts"] },
      },
      { test: { name: "tools", environment: "node", include: ["test/invite.test.ts", "test/seed.test.ts"] } },
    ],
  },
});
