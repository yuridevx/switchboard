import { fileURLToPath } from "node:url";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import { clickhouse } from "./test/clickhouse.ts";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  plugins: [
    // ClickHouse — поддельный в Node: исходящие запросы Worker'а уходят в него; токен Access и пароль поддельные
    cloudflareTest({
      main: here("./src/index.ts"),
      miniflare: {
        compatibilityDate: "2026-08-01",
        compatibilityFlags: ["nodejs_compat"],
        outboundService: clickhouse,
        bindings: { CH_URL: "https://ch.test", CH_ACCESS_ID: "aid0", CH_ACCESS_SECRET: "asec0", CH_USER: "sb_test", CH_PASSWORD: "pass0", BLOCKS_URL: "https://blocks.test" },
      },
    }),
  ],
  test: { include: ["test/**/*.test.ts"] },
});
