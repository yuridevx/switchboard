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
        ],
        // ключ ссылок и аккаунт — поддельные: ссылки подписываются на месте, в сеть служба не ходит
        bindings: { CF_ACCOUNT_ID: "acc0", R2_KEY_ID: "kid0", R2_KEY_SECRET: "ksec0", TEST_MIGRATIONS: await readD1Migrations(here("./migrations")) },
      },
    }),
  ],
  // сотни объектов R2 и точек: на Linux тест идёт 5–7 с и на прежнем коде
  test: { include: ["test/**/*.test.ts"], testTimeout: 30_000 },
});
