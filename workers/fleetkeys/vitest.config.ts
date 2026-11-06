import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import { gateStand } from "@switchboard/gate";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: here("./wrangler.jsonc") },
      miniflare: {
        workers: [
          gateStand(),
          {
            name: "switchboard",
            modules: true,
            compatibilityDate: "2026-08-01",
            script: `import { WorkerEntrypoint } from "cloudflare:workers";
export class Relay extends WorkerEntrypoint {
  async deliver() { return 0; }
}
export default { fetch: () => new Response(null, { status: 404 }) };`,
          },
        ],
        bindings: { TEST_MIGRATIONS: await readD1Migrations(here("./migrations")) },
      },
    }),
  ],
  test: { include: ["test/**/*.test.ts"] },
});
