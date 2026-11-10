// Записать ключ Meta из конфига Muse этого компьютера ключом флота: node tools/fleet/key-muse.ts <флот> <устройство> [имя ключа] [модель]
// Значение читается из ~/.config/muse/auth.json и не печатается.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApi, httpTransport, keysSet } from "@sb/protocol";

const dir = path.join(os.homedir(), ".switchboard-dev");
const env = Object.fromEntries(fs.readFileSync(path.join(dir, "v2-fleet.env"), "utf8").split("\n").filter((l) => l && !l.startsWith("#")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]));
const [fleet = "test", device = "cli", name = "muse", model] = process.argv.slice(2);
const meta = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config", "muse", "auth.json"), "utf8")).providers?.meta;
const value = meta?.api_key || meta?.access_token;
if (!value) throw new Error("в конфиге Muse нет ключа Meta");
const key = fs.readFileSync(path.join(dir, `v2-${fleet}-${device}.pass`), "utf8").trim();
const api = createApi(httpTransport({ base: env.SB2_BASE!, key }));
await api.call(keysSet, { name, provider: "meta", value, base: meta.api_base_url ?? "https://api.meta.ai/v1", ...(model ? { model } : {}) });
console.log(`ключ флота ${name} записан: провайдер meta, адрес ${meta.api_base_url ?? "https://api.meta.ai/v1"}${model ? ", модель " + model : ""}; взято поле ${meta.api_key ? "api_key" : "access_token"}`);
