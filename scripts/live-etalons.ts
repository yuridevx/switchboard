// Эталоны, которые проверяются только на выложенном тестовом флоте (не на живом флоте пользователя):
//   144 — секреты и адреса семи Worker (адрес — у каждого); 136 и 145 — выпуск push и gate не рвёт соединения relay;
//   5027 — отзыв пропуска keys.revoke на входе relay: соединение закрыто сразу, новый hello — revoked; пропуска эталона отозваны.
// Токен деплоя — из ~/.switchboard-dev (SWITCHBOARD_DEV_DIR), как у deploy-workers.mjs. Пропуска эталона — приглашением:
// агент эталона заводится seed'ом в базу gate, в конце прогона отзывает всё, что выдал, и себя.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { link, type Link } from "@switchboard/relay";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dev = process.env.SWITCHBOARD_DEV_DIR ?? join(homedir(), ".switchboard-dev");
const env: Record<string, string> = {};
for (const f of ["cf-deploy.env", "fleet-secrets.env"])
  for (const line of readFileSync(join(dev, f), "utf8").split(/\r?\n/)) {
    const i = line.indexOf("=");
    if (i > 0) env[line.slice(0, i)] = line.slice(i + 1);
  }
const url = "wss://switchboard.yuridevx1608.workers.dev";
const api = (path: string) =>
  fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}${path}`, { headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` } }).then((r) => r.json() as Promise<{ result: unknown }>);
const wrangler = (dir: string, args: string[]) => {
  const r = spawnSync(process.execPath, [join(root, "node_modules/wrangler/bin/wrangler.js"), ...args], { cwd: join(root, "workers", dir), env: { ...process.env, CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID }, encoding: "utf8", timeout: 300_000 });
  if (r.status !== 0) throw new Error(`wrangler ${args.join(" ")} в ${dir}: ${r.error?.message ?? r.stderr.slice(-500)}`);
};
const fails: string[] = [];
const check = (n: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${n}${detail === undefined ? "" : " · " + JSON.stringify(detail)}`);
  if (!ok) fails.push(n);
};
const until = async (ok: () => boolean, ms = 20000) => {
  for (const t0 = Date.now(); !ok(); ) {
    if (Date.now() - t0 > ms) return false;
    await new Promise((r) => setTimeout(r, 200));
  }
  return true;
};
const opened = (l: Link) => until(() => l.state === "open");

// 144 — секреты и адреса; адрес — у каждого Worker'а флота: прямой вход (пакет «Открытый флот»)
const PUBLIC = ["switchboard", "switchboard-gate", "switchboard-push", "switchboard-points", "switchboard-ledger", "switchboard-github", "switchboard-fleetkeys", "switchboard-releases"];
const SECRETS: Record<string, string[]> = { switchboard: [], "switchboard-gate": [], "switchboard-push": ["VAPID_PRIVATE"], "switchboard-points": ["R2_KEY_SECRET"], "switchboard-ledger": [], "switchboard-github": [], "switchboard-fleetkeys": [], "switchboard-releases": ["CLOUDFLARE_API_TOKEN", "R2_LINK_KEY_ID", "R2_LINK_SECRET"] };
for (const [w, want] of Object.entries(SECRETS)) {
  const sec = ((await api(`/workers/scripts/${w}/secrets`)).result as Array<{ name: string }>).map((s) => s.name).sort();
  const sub = (await api(`/workers/scripts/${w}/subdomain`)).result as { enabled: boolean; previews_enabled: boolean };
  const pub = PUBLIC.includes(w);
  check(`144 · ${w}: секреты ${JSON.stringify(want)}, адрес ${pub ? "есть" : "нет"}`, JSON.stringify(sec) === JSON.stringify(want) && sub.enabled === pub && !sub.previews_enabled, { sec, sub });
}

// агент эталона и его пропуска — приглашением
const gateUrl = "https://switchboard-gate.yuridevx1608.workers.dev/";
const relayUrl = "https://switchboard.yuridevx1608.workers.dev/";
const post = (u: string, f: Record<string, unknown>) =>
  fetch(u, { method: "POST", body: JSON.stringify({ id: "e", v: 1, ...f }) }).then((r) => r.json() as Promise<{ ok: boolean; result?: any; error?: string }>);
const seeded = spawnSync(process.execPath, [join(root, "workers/gate/seed.ts"), "etalon-agent~etalon@example.com"], { encoding: "utf8", timeout: 60_000 });
wrangler("gate", ["d1", "execute", "switchboard-gate", "--remote", "--command", seeded.stdout.trim()]);
const agent = (await post(gateUrl, { type: "gate.redeem", invite: seeded.stderr.trim() })).result.key as string;
const mine: string[] = [agent.split(".").at(-2)!];
const pass = async (role: "host" | "client", name: string) => {
  const inv = await post(gateUrl, { type: "keys.invite", v: 2, key: agent, addr: role === "host" ? `@${name}` : `${name}~etalon@example.com` });
  mine.push(inv.result.kid);
  return (await post(gateUrl, { type: "gate.redeem", invite: inv.result.invite })).result.key as string;
};
// 136 и 145 — выпуск push и gate при открытых соединениях объекта машины etalon
const eUrl = url + "/m/etalon";
const host = link({ url: eUrl, key: await pass("host", "etalon"), hello: () => ({ sdk: "etalon", contract: {}, sessions: [] }) });
const phone = link({ url: eUrl, key: await pass("client", "etalon-phone") });
await opened(host);
await opened(phone);
const since = host.roster?.machines.find((m) => m.machine === "etalon")?.since;
let rosters = 0;
const phone2 = link({ url: eUrl, key: await pass("client", "etalon-watch"), onFrame: (f) => void (f.type === "roster" && rosters++) });
await opened(phone2);
await new Promise((r) => setTimeout(r, 1000));
rosters = 0;
wrangler("push", ["deploy"]);
wrangler("gate", ["deploy"]);
await new Promise((r) => setTimeout(r, 3000));
const same = host.state === "open" && phone.state === "open" && host.roster?.machines.find((m) => m.machine === "etalon")?.since === since;
check("136 · 145 · выпуск push и gate: соединения relay живы, roster не разослан заново", same && rosters === 0, { host: host.state, phone: phone.state, rosters });
const k = await post("https://switchboard-push.yuridevx1608.workers.dev/", { type: "push.key", key: agent });
check("145 · следующий push.send/push.key — у новой версии push", k.ok === true);
const fresh = link({ url: eUrl, key: await pass("client", "etalon-new") });
check("145 · следующий hello проверен новой версией gate", await opened(fresh));
fresh.close();

const mUrl = url + "/m/etalon-m";
const mHost = link({ url: mUrl, key: await pass("host", "etalon-m"), hello: () => ({ sdk: "etalon", contract: {}, sessions: [] }) });
const victimKey = await pass("client", "etalon-victim");
const victim = link({ url: mUrl, key: victimKey });
await opened(mHost);
await opened(victim);
const rv = await post(relayUrl, { type: "keys.revoke", key: agent, kid: victimKey.split(".")[2] });
check("5027 · keys.revoke → отметка у gate и соединение закрыто на объекте машины", rv.ok && rv.result.closed >= 1, rv);
check("5027 · соединение отозванного пропуска закрыто без переподключения", await until(() => victim.state === "stopped", 15000), victim.state);
check("5027 · Host машины на связи", mHost.state === "open", mHost.state);
const again = link({ url: mUrl, key: victimKey });
await until(() => again.state !== "connecting", 15000);
check("5027 · новый hello отозванным пропуском не пускают", again.state === "stopped", again.state);
again.close();
mHost.close(1000, "done");
// живых пропусков эталона после прогона — 0: отзыв своих, последним — пропуск агента
for (const kid of mine.reverse()) await post(relayUrl, { type: "keys.revoke", key: agent, kid });
const left = (await post(gateUrl, { type: "keys.list", v: 2, key: agent })).error;
check("живых пропусков эталона после прогона 0", left === "bad_key", left);

for (const l of [host, phone, phone2, victim]) l.close(1000, "done");
console.log(fails.length ? `live-etalons: ${fails.length} провалов` : "live-etalons: ok");
process.exit(fails.length ? 1 : 0);
