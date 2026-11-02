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
        workers: [
          gateStand(),
          // relay стенда: deliver считает кадры — план keeper'у уходит в объект его машины
          {
            name: "switchboard",
            modules: true,
            compatibilityDate: "2026-08-01",
            script: `import { WorkerEntrypoint } from "cloudflare:workers";
const got = [];
export class Relay extends WorkerEntrypoint {
  async deliver(f) { got.push(f); return f.to === ".keeper@win" ? 1 : 0; }
  delivered() { return got; }
  clear() { got.length = 0; }
}
export default { fetch: () => new Response(null, { status: 404 }) };`,
          },
        ],
        // ключи — поддельные: API Cloudflare в тестах подменён, ссылки только подписываются
        bindings: { CLOUDFLARE_API_TOKEN: "test-token", CF_ACCOUNT_ID: "acc0", R2_LINK_KEY_ID: "AK", R2_LINK_SECRET: "SK" },
      },
    }),
  ],
  test: { include: ["test/**/*.test.ts"] },
});
