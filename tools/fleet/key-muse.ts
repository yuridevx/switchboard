// Записать ключ Meta из конфига Muse этого компьютера ключом флота: node tools/fleet/key-muse.ts <флот> <устройство> [имя ключа]
// Значение читается из ~/.config/muse/auth.json и не печатается.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApi, httpTransport, keysSet } from "@sb/protocol";
import { fleetEnv } from "../dev.mjs";

const dir = path.join(os.homedir(), ".switchboard-dev");
const env = fleetEnv;
const [fleet = "test", device = "cli", name = "muse"] = process.argv.slice(2);
const meta = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config", "muse", "auth.json"), "utf8")).providers?.meta;
const value = meta?.api_key || meta?.access_token;
if (!value) throw new Error("в конфиге Muse нет ключа Meta");
const key = fs.readFileSync(path.join(dir, `v2-${fleet}-${device}.pass`), "utf8").trim();
const api = createApi(httpTransport({ base: env.SB2_BASE!, key }));
await api.call(keysSet, { name, protocol: "meta", value, base: meta.api_base_url ?? "https://api.meta.ai/v1" });
console.log(`ключ флота ${name} записан: протокол meta, адрес ${meta.api_base_url ?? "https://api.meta.ai/v1"}; взято поле ${meta.api_key ? "api_key" : "access_token"}`);
