// Эталоны, которые проверяются только на выложенном тестовом флоте (не на живом флоте пользователя):
//   144 — секреты и адреса семи Worker (адрес — у relay и gate); 136 и 145 — выпуск push и gate не рвёт соединения relay;
//   117 — отзыв ключа выпуском gate: соединение закрыто при ближайшем старте объекта флота, новый hello — revoked.
// Токен деплоя и секрет флота — из ~/.switchboard-dev (SWITCHBOARD_DEV_DIR), как у deploy-workers.mjs.
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
const invite = (role: string, name: string) =>
  spawnSync(process.execPath, [join(root, "workers/gate/invite.ts"), role, name], { input: env.FLEET_SECRET, encoding: "utf8" }).stdout.trim();
const wrangler = (dir: string, args: string[]) => {
  const r = spawnSync(process.execPath, [join(root, "node_modules/wrangler/bin/wrangler.js"), ...args], { cwd: join(root, "workers", dir), env: { ...process.env, CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID }, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`wrangler ${args.join(" ")} в ${dir}: ${r.stderr.slice(-500)}`);
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

// 144 — секреты и адреса; адрес — у relay и тех, к кому ходят напрямую (пакет «Открытый флот»: gate с шага 1)
const PUBLIC = ["switchboard", "switchboard-gate"];
const SECRETS: Record<string, string[]> = { switchboard: [], "switchboard-gate": ["FLEET_SECRET"], "switchboard-push": ["VAPID_PRIVATE"], "switchboard-points": ["R2_KEY_SECRET"], "switchboard-ledger": [], "switchboard-github": [], "switchboard-releases": ["CLOUDFLARE_API_TOKEN", "R2_LINK_KEY_ID", "R2_LINK_SECRET"] };
for (const [w, want] of Object.entries(SECRETS)) {
  const sec = ((await api(`/workers/scripts/${w}/secrets`)).result as Array<{ name: string }>).map((s) => s.name).sort();
  const sub = (await api(`/workers/scripts/${w}/subdomain`)).result as { enabled: boolean; previews_enabled: boolean };
  const pub = PUBLIC.includes(w);
  check(`144 · ${w}: секреты ${JSON.stringify(want)}, адрес ${pub ? "есть" : "нет"}`, JSON.stringify(sec) === JSON.stringify(want) && sub.enabled === pub && !sub.previews_enabled, { sec, sub });
}

// 136 и 145 — выпуск push и gate при открытых соединениях
const host = link({ url, key: invite("host", "etalon"), hello: () => ({ sdk: "etalon", contract: {}, sessions: [] }) });
const phone = link({ url, key: invite("client", "etalon-phone") });
await opened(host);
await opened(phone);
const since = host.roster?.machines.find((m) => m.machine === "etalon")?.since;
let rosters = 0;
const phone2 = link({ url, key: invite("client", "etalon-watch"), onFrame: (f) => void (f.type === "roster" && rosters++) });
await opened(phone2);
await new Promise((r) => setTimeout(r, 1000));
rosters = 0;
wrangler("push", ["deploy"]);
wrangler("gate", ["deploy"]);
await new Promise((r) => setTimeout(r, 3000));
const same = host.state === "open" && phone.state === "open" && host.roster?.machines.find((m) => m.machine === "etalon")?.since === since;
check("136 · 145 · выпуск push и gate: соединения relay живы, roster не разослан заново", same && rosters === 0, { host: host.state, phone: phone.state, rosters });
const k = await phone.request({ type: "push.key", v: 1, to: ".push" });
check("145 · следующий push.send/push.key — у новой версии push", k.ok === true);
const fresh = link({ url, key: invite("client", "etalon-new") });
check("145 · следующий hello проверен новой версией gate", await opened(fresh));
fresh.close();

// 117 — отзыв ключа: gate с REVOKED, затем relay
const revokedKey = invite("client", "etalon-revoked");
const victim = link({ url, key: revokedKey });
await opened(victim);
const kid = revokedKey.split(".").slice(0, 3).join(".");
wrangler("gate", ["deploy", "--var", `REVOKED:${JSON.stringify([kid])}`]);
await new Promise((r) => setTimeout(r, 3000));
check("117 · после выпуска gate с отзывом соединение живо", victim.state === "open", victim.state);
// объект флота засыпает между кадрами; ping отвечает Cloudflare без пробуждения. Пауза — и кадр его будит:
// при старте объект перепроверяет отозванные ключи открытых соединений
await new Promise((r) => setTimeout(r, 30000));
await host.request({ type: "push.key", v: 1, to: ".push" });
const closed = await until(() => victim.state === "stopped", 30000);
check("117 · объект флота стартовал — соединение отозванного ключа закрыто", closed, victim.state);
check("117 · Host и клиенты на связи", host.state === "open" && phone.state === "open", { host: host.state, phone: phone.state });
const again = link({ url, key: revokedKey });
await until(() => again.state !== "connecting", 15000);
check("117 · новый hello отозванным ключом не пускают", again.state === "stopped", again.state);
again.close();
// вернуть gate без отзыва
wrangler("gate", ["deploy"]);

for (const l of [host, phone, phone2, victim]) l.close(1000, "done");
console.log(fails.length ? `live-etalons: ${fails.length} провалов` : "live-etalons: ok");
process.exit(fails.length ? 1 : 0);
