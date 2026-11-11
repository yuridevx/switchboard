import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import { blocksStand } from "@switchboard/blocks";
import { gateStand } from "@switchboard/gate";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: here("./wrangler.jsonc") },
      miniflare: {
        workers: [
          gateStand(),
          // хранилище блоков: стенд контракта blocks в памяти
          blocksStand(),
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
        bindings: { TEST_MIGRATIONS: await readD1Migrations(here("./migrations")) },
      },
    }),
  ],
  // сотни блоков и точек: на Linux тест идёт 5–7 с
  test: { include: ["test/**/*.test.ts"], testTimeout: 30_000 },
});
