import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import { gateStand } from "@switchboard/gate";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/** relay для привязки: сами тесты подставляют свой, с записью кадров. */
const relayStand = { name: "switchboard", modules: true, script: `import { WorkerEntrypoint } from "cloudflare:workers"; export class Relay extends WorkerEntrypoint { deliver() { return 0; } }` };

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: here("./wrangler.jsonc") },
      miniflare: {
        workers: [gateStand(), relayStand],
        bindings: { TELEGRAM_BOT_TOKEN: "123456789:test-token", TEST_MIGRATIONS: await readD1Migrations(here("./migrations")) },
      },
    }),
  ],
  test: { include: ["test/**/*.test.ts"] },
});
