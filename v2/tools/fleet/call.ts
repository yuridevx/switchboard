// Один запрос флоту с пропуском из файла: node tools/fleet/call.ts <флот> <устройство> <имя запроса> ['<поля JSON>']
// Печатает ответ целиком: исход, слово отказа, путь запроса по частям.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { httpTransport, newId } from "@sb/protocol";
import { fleetEnv } from "../dev.mjs";

const dir = path.join(os.homedir(), ".switchboard-dev");
const env = fleetEnv;
const [fleet, device, type, json = "{}"] = process.argv.slice(2);
if (!fleet || !device || !type) throw new Error("нужно: <флот> <устройство> <имя запроса> ['<поля JSON>']");
const key = fs.readFileSync(path.join(dir, `v2-${fleet}-${device}.pass`), "utf8").trim();
const reply = await httpTransport({ base: env.SB2_BASE!, key }).call({ ...JSON.parse(json), type, id: newId("r"), trace: newId("t") });
console.log(JSON.stringify(reply, null, 2));
process.exit(reply.ok ? 0 : 1);
