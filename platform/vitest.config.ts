import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" }, miniflare: { bindings: { BOOT: "boot-secret", HELLO_MS: "300", CALL_MS: "1500" } } })],
  test: { include: ["test/**/*.test.ts"], testTimeout: 20_000 },
});
