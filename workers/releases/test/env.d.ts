// Привязки Worker'а глазами лесов — из wrangler.jsonc и vitest.config.ts.
declare global {
  namespace Cloudflare {
    interface Env {
      BUCKET: R2Bucket;
      DB: D1Database;
      GATE: Fetcher;
      RELAY: Fetcher;
      LEDGER: Fetcher;
      FLEET: string;
      CF_ACCOUNT_ID: string;
      CLOUDFLARE_API_TOKEN: string;
      R2_LINK_KEY_ID: string;
      R2_LINK_SECRET: string;
    }
  }
}
export {};
