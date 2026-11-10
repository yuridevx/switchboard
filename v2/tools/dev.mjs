// Настройки разработки вне репо (~/.switchboard-dev): один разбор для всех скриптов v2.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const dev = path.join(os.homedir(), ".switchboard-dev");
/** Файл вида КЛЮЧ=значение; строки с # и без = пропускаются; файла нет — пусто. */
export const readEnv = (file) => (fs.existsSync(file) ? Object.fromEntries(fs.readFileSync(file, "utf8").split("\n").filter((l) => l.includes("=") && !l.startsWith("#")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()])) : {});
/** Адреса и секреты тестового флота v2. */
/** Файл настроек флота: тестовый по умолчанию; SB2_ENV=prod — прод (v2-prod.env). */
export const fleetEnvFile = path.join(dev, process.env.SB2_ENV === "prod" ? "v2-prod.env" : "v2-fleet.env");
export const fleetEnv = readEnv(fleetEnvFile);
