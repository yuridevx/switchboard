// Доступ к бакету файлов из браузера (правило CORS): страница кладёт и читает содержимое по подписанным ссылкам, мимо Worker'а и мимо машины.
// node tools/deploy/cors.mjs         — бакет тестового флота (sb2-files)
// node tools/deploy/cors.mjs prod    — бакет прода (sb2-files-prod)
// Повторный запуск ставит то же правило. Токен — из ~/.switchboard-dev/v2-cloudflare.env, в аргументы не идёт.
import path from "node:path";
import { dev, readEnv } from "../dev.mjs";

const env = readEnv(path.join(dev, "v2-cloudflare.env"));
const bucket = process.argv[2] === "prod" ? "sb2-files-prod" : "sb2-files";
const url = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/r2/buckets/${bucket}/cors`;
const api = async (method, body) => {
  const r = await fetch(url, { method, headers: { authorization: "Bearer " + env.CLOUDFLARE_API_TOKEN, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const j = await r.json();
  if (!j.success) throw new Error(`${method} ${bucket}/cors: HTTP ${r.status} ${JSON.stringify(j.errors).slice(0, 300)}`);
  return j.result;
};

// ссылка подписана и живёт час: читать и класть по ней можно с любой страницы; имя скачанного файла несёт сама ссылка
await api("PUT", { rules: [{ allowed: { origins: ["*"], methods: ["GET", "PUT", "HEAD"], headers: ["content-type"] }, exposeHeaders: ["ETag"], maxAgeSeconds: 3600 }] });
const now = await api("GET");
console.log(`${bucket}: правил доступа из браузера — ${now.rules?.length ?? 0}`, JSON.stringify(now.rules));
