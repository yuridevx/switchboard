// Адреса сайтов флота в зоне Cloudflare — один раз на флот: node tools/deploy/sites.mjs [prod]
// Ставит запись DNS «*.<зона>» (одна на оба флота) и маршрут «*<хвост>/*» на Worker служб этого флота. Повторный запуск ничего не меняет.
// Хвост и имя Worker'а берёт из services/wrangler.jsonc (SITES_HOST). В настройке выкладки маршрута нет: токену выкладки CI маршруты зоны
// не даны, а маршрут в настройке wrangler ещё и снимает с Worker'а адрес workers.dev (на нём стоит тестовый флот).
// Токен — из ~/.switchboard-dev/v2-cloudflare.env (или файла SB2_CLOUDFLARE_ENV), идёт заголовком, не аргументом.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const prod = process.argv[2] === "prod";
const env = {};
for (const l of fs.readFileSync(process.env.SB2_CLOUDFLARE_ENV ?? path.join(os.homedir(), ".switchboard-dev", "v2-cloudflare.env"), "utf8").split("\n")) {
  if (!l || l.startsWith("#")) continue;
  const i = l.indexOf("=");
  env[l.slice(0, i)] = l.slice(i + 1).trim();
}
const conf = JSON.parse(fs.readFileSync(path.join(root, "services/wrangler.jsonc"), "utf8").replace(/^\s*\/\/.*$/gm, ""));
const tail = (prod ? conf.env.prod : conf).vars.SITES_HOST;
const script = prod ? `${conf.name}-prod` : conf.name;
// хвост «-t.pfarm.app»: зона — всё после первой точки
const zoneName = tail.slice(tail.indexOf(".") + 1);

async function cf(method, p, body) {
  const r = await fetch("https://api.cloudflare.com/client/v4" + p, { method, headers: { authorization: "Bearer " + env.CLOUDFLARE_API_TOKEN, "content-type": "application/json" }, body: body && JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  const j = await r.json();
  if (!j.success) throw new Error(`${method} ${p}: ${r.status} ${JSON.stringify(j.errors)}`);
  return j.result;
}

const zone = (await cf("GET", `/zones?name=${zoneName}`))[0]?.id;
if (!zone) throw new Error(`зоны ${zoneName} у токена нет`);
const star = `*.${zoneName}`;
const records = await cf("GET", `/zones/${zone}/dns_records?name=${encodeURIComponent(star)}`);
if (records.length) console.log(`= запись DNS ${star} есть`);
else {
  await cf("POST", `/zones/${zone}/dns_records`, { type: "AAAA", name: star, content: "100::", proxied: true, comment: "switchboard: сайты флота — поддомены с хвостом идут в Worker служб по маршруту" });
  console.log(`✓ запись DNS ${star} создана`);
}
const pattern = `*${tail}/*`;
const routes = await cf("GET", `/zones/${zone}/workers/routes`);
const have = routes.find((r) => r.pattern === pattern);
if (have?.script === script) console.log(`= маршрут ${pattern} → ${script} есть`);
else if (have) throw new Error(`маршрут ${pattern} уже ведёт на ${have.script}: чужой маршрут не трогаю`);
else {
  await cf("POST", `/zones/${zone}/workers/routes`, { pattern, script });
  console.log(`✓ маршрут ${pattern} → ${script} создан`);
}
