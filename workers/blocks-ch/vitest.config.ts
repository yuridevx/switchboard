import { fileURLToPath } from "node:url";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import { clickhouse } from "./test/clickhouse.ts";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  plugins: [
    // без wrangler.jsonc: привязка VPC в нём требует сети; ClickHouse — поддельный в Node, пароль поддельный
    cloudflareTest({
      main: here("./src/index.ts"),
      miniflare: {
        compatibilityDate: "2026-08-01",
        compatibilityFlags: ["nodejs_compat"],
        serviceBindings: { CH: clickhouse },
        bindings: { CH_USER: "sb_test", CH_PASSWORD: "pass0", BLOCKS_URL: "https://blocks.test" },
      },
    }),
  ],
  test: { include: ["test/**/*.test.ts"] },
});
