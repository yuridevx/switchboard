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
        // ключ ссылок и аккаунт — поддельные: ссылки подписываются на месте, в сеть служба не ходит
        bindings: { CF_ACCOUNT_ID: "acc0", R2_KEY_ID: "kid0", R2_KEY_SECRET: "ksec0" },
      },
    }),
  ],
  test: { include: ["test/**/*.test.ts"] },
});
