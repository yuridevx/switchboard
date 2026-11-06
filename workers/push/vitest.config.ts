import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
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

/** Стенд rooms: исход — по имени устройства в адресе; чатов у остальных адресов нет. */
const roomsStand = {
  name: "switchboard-rooms",
  modules: true,
  script: `import { WorkerEntrypoint } from "cloudflare:workers";
export class Rooms extends WorkerEntrypoint {
  send({ to }) {
    if (to.startsWith("telegram~")) return { sent: 1 };
    if (to.startsWith("limited~")) return { sent: 0, word: "rate_limited", why: "предел Telegram, повторить через 37 с" };
    if (to.startsWith("broken~")) throw new Error("rooms упал");
    return { sent: 0 };
  }
}`,
};

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: here("./wrangler.jsonc") },
      miniflare: {
        workers: [gateStand(), roomsStand],
        bindings: { VAPID_PRIVATE: JSON.stringify(TEST_VAPID), TEST_MIGRATIONS: await readD1Migrations(here("./migrations")) },
      },
    }),
  ],
  test: { include: ["test/**/*.test.ts"] },
});
