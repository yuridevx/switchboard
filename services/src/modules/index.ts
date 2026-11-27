// Список модулей служб: вход собирает их отсюда.
export { analytics, consume } from "./analytics/analytics.ts";
export { archive } from "./archive/archive.ts";
export { builds } from "./builds/builds.ts";
export { clock } from "./clock/clock.ts";
export { factory } from "./factory/factory.ts";
export { files } from "./files/files.ts";
export { github } from "./github/github.ts";
export { githubHook, hook, hooks } from "./hooks/hooks.ts";
export { keys } from "./keys/keys.ts";
export { ledger } from "./ledger/ledger.ts";
export { mcp } from "./mcp/mcp.ts";
export { obs } from "./obs/obs.ts";
export { prefs } from "./prefs/prefs.ts";
export { reach, telegram } from "./reach/reach.ts";
export { site, sites } from "./sites/sites.ts";
