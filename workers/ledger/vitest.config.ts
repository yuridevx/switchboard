import { fileURLToPath } from "node:url";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: here("./wrangler.jsonc") },
      miniflare: {
        serviceBindings: { RELAY_LOG: { name: "switchboard", entrypoint: "Log" } },
        workers: [{ name: "switchboard", modules: true, scriptPath: here("./test/relay-stub.js"), compatibilityDate: "2026-08-01" }],
      },
    }),
  ],
  test: { include: ["test/**/*.test.ts"] },
});
