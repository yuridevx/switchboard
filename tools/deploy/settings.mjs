// Настройки раннера CI: секреты из окружения — в файлы ~/.switchboard-dev, откуда их читают все скрипты выкладки и проверки.
// node tools/deploy/settings.mjs <флот> [устройство]
// Окружение: SB2_BASE — адрес флота, SB2_PASS — пропуск устройства, CLOUDFLARE_API_TOKEN и CLOUDFLARE_ACCOUNT_ID — для wrangler.
// SB2_ENV=prod — настройки прода (v2-prod.env). Значения не печатаются; чего нет в окружении — отказ словом.
import fs from "node:fs";
import path from "node:path";
import { dev, fleetEnvFile } from "../dev.mjs";

const [fleet, device = "ci"] = process.argv.slice(2);
if (!fleet) throw new Error("нужно: <флот> [устройство]");
const need = (name) => {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`в окружении нет ${name}`);
  return v;
};
fs.mkdirSync(dev, { recursive: true, mode: 0o700 });
const write = (file, text) => fs.writeFileSync(file, text, { mode: 0o600 });
write(fleetEnvFile, `SB2_BASE=${need("SB2_BASE")}\n`);
write(path.join(dev, `v2-${fleet}-${device}.pass`), need("SB2_PASS") + "\n");
if (process.env.CLOUDFLARE_API_TOKEN) write(path.join(dev, "v2-cloudflare.env"), `CLOUDFLARE_ACCOUNT_ID=${need("CLOUDFLARE_ACCOUNT_ID")}\nCLOUDFLARE_API_TOKEN=${need("CLOUDFLARE_API_TOKEN")}\n`);
console.log(`настройки флота ${fleet}: устройство ${device}${process.env.CLOUDFLARE_API_TOKEN ? ", ключ Cloudflare" : ""}`);
