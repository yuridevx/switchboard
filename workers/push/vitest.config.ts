import { fileURLToPath } from "node:url";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import { gateStand } from "@switchboard/gate";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// Тестовый ключ VAPID — только для тестов.
export const TEST_VAPID = {
  kty: "EC",
  crv: "P-256",
  x: "Z9n-QahzdphvttZRosJgwzKE2YP7vtB04K7UcPf1__I",
  y: "x1p7dXMngTxFAzJ-1czWxvud2a6VOTmZC4OVuvh6JIo",
  d: "OjZnX4wRA2wmrJ6gmJD5NCmxTu7AZS3EVMKaQot7UIQ",
};

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: here("./wrangler.jsonc") },
      miniflare: {
        workers: [gateStand()],
        bindings: { VAPID_PRIVATE: JSON.stringify(TEST_VAPID) },
      },
    }),
  ],
  test: { include: ["test/**/*.test.ts"] },
});
