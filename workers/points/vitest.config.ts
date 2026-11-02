import { fileURLToPath } from "node:url";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: here("./wrangler.jsonc") },
      miniflare: {
        // настройки API Cloudflare — поддельные: API в тестах подменён
        bindings: { R2_TOKEN: "test-token", CF_ACCOUNT_ID: "acc0", R2_PARENT_KEY_ID: "parent0" },
      },
    }),
  ],
  test: { include: ["test/**/*.test.ts"] },
});
