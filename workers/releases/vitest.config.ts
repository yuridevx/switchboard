import { fileURLToPath } from "node:url";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import { gateStand } from "@switchboard/gate";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: here("./wrangler.jsonc") },
      miniflare: {
        workers: [gateStand()],
        // ключи — поддельные: API Cloudflare в тестах подменён, ссылки только подписываются
        bindings: { CLOUDFLARE_API_TOKEN: "test-token", CF_ACCOUNT_ID: "acc0", R2_LINK_KEY_ID: "AK", R2_LINK_SECRET: "SK" },
      },
    }),
  ],
  test: { include: ["test/**/*.test.ts"] },
});
