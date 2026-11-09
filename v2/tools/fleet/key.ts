// Записать ключ флота из файла (значение не идёт через аргументы): node tools/fleet/key.ts <флот> <устройство> <имя> <провайдер> <адрес> <модель> <файл со значением>
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApi, httpTransport, keysSet } from "@sb/protocol";

const dir = path.join(os.homedir(), ".switchboard-dev");
const env = Object.fromEntries(fs.readFileSync(path.join(dir, "v2-fleet.env"), "utf8").split("\n").filter((l) => l && !l.startsWith("#")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]));
const [fleet, device, name, provider, base, model, file] = process.argv.slice(2);
if (!fleet || !device || !name || !provider || !file) throw new Error("нужно: <флот> <устройство> <имя> <провайдер> <адрес> <модель> <файл со значением>");
const key = fs.readFileSync(path.join(dir, `v2-${fleet}-${device}.pass`), "utf8").trim();
const api = createApi(httpTransport({ base: env.SB2_BASE!, key }));
await api.call(keysSet, { name, provider, value: fs.readFileSync(file, "utf8").trim(), ...(base ? { base } : {}), ...(model ? { model } : {}) });
console.log(`ключ флота ${name} записан`);
