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
          // журнал стенда: строки по привязке
          {
            name: "switchboard-ledger",
            modules: true,
            compatibilityDate: "2026-08-01",
            script: `import { WorkerEntrypoint } from "cloudflare:workers";
const got = [];
export class Participant extends WorkerEntrypoint {
  async frame(f) { got.push(f); return []; }
  got() { return got; }
  clear() { got.length = 0; }
}
export default { fetch: () => new Response(null, { status: 404 }) };`,
          },
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
        bindings: { CLOUDFLARE_API_TOKEN: "test-token", CF_ACCOUNT_ID: "acc0", R2_LINK_KEY_ID: "AK", R2_LINK_SECRET: "SK", TEST_MIGRATIONS: await readD1Migrations(here("./migrations")) },
      },
    }),
  ],
  test: { include: ["test/**/*.test.ts"] },
});
