// Тесты gate: проект gate — Worker в workerd (miniflare) с секретом теста; проект invite — инструмент в Node.
import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

export default defineConfig({
  test: {
    projects: [
      {
        plugins: [
          cloudflareTest({
            wrangler: { configPath: "./wrangler.jsonc" },
            miniflare: { bindings: { FLEET_SECRET: "test-secret", REVOKED: ["client.phone.k2a9"] } },
          }),
        ],
        test: { name: "gate", include: ["test/gate.test.ts"] },
      },
      { test: { name: "invite", environment: "node", include: ["test/invite.test.ts"] } },
    ],
  },
});
