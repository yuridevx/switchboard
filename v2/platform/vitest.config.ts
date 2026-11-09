import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" }, miniflare: { bindings: { BOOT: "boot-secret" } } })],
  test: { include: ["test/**/*.test.ts"], testTimeout: 20_000 },
});
