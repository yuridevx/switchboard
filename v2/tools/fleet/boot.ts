// Завести флот и получить первый пропуск админа: node tools/fleet/boot.ts <флот> <~почта> [имя устройства]
// Секрет BOOT, адрес платформы (SB2_PLATFORM) и адрес флота (SB2_BASE) — из ~/.switchboard-dev/v2-fleet.env; пропуск пишется в ~/.switchboard-dev/v2-<флот>-<устройство>.pass.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isReply, parseFrame } from "@sb/protocol";
import { fleetEnv } from "../dev.mjs";

const dir = path.join(os.homedir(), ".switchboard-dev");
const env = fleetEnv;
const [fleet, person, device = "cli"] = process.argv.slice(2);
if (!fleet || !person) throw new Error("нужно: <флот> <~почта> [устройство]");
const platform = env.SB2_PLATFORM!, base = env.SB2_BASE!;

const boot = await fetch(platform + "/boot", { method: "POST", headers: { authorization: "Bearer " + env.SB2_BOOT, "content-type": "application/json" }, body: JSON.stringify({ fleet, person, device }) });
const bootText = await boot.text();
if (!boot.ok) throw new Error("boot: " + boot.status + " " + bootText);
const { invite } = JSON.parse(bootText) as { invite: string };

// Приём приглашения — обычный запрос без пропуска на адрес флота.
const r = await fetch(base + "/call", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "redeem", id: "boot", invite }) });
const reply = parseFrame(await r.text());
if (!reply || !isReply(reply) || !reply.ok) throw new Error("redeem: " + JSON.stringify(reply));
const { key, addr } = reply.result as { key: string; addr: string };
const file = path.join(dir, `v2-${fleet}-${device}.pass`);
fs.writeFileSync(file, key + "\n");
console.log(`флот ${fleet}: пропуск ${addr} записан в ${file}`);
