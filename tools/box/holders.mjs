// Снять процессы машины с компьютера. Host и процессы сессий живут у держателей и службу машины переживают:
// их снимает тот, кто убирает машину, — коробка при снятии и проверка «установка службы машины» за собой.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** Снять процесс вместе с потомками. */
export function killTree(pid) {
  try {
    if (process.platform === "win32") execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    else process.kill(-pid, "SIGKILL");
  } catch {
    // процесса уже нет
  }
}

/** Снять всё, что у держателей машины: home — её папка флота, держатели записаны в procs/. */
export function killHolders(home) {
  const procs = path.join(home, "procs");
  for (const f of fs.existsSync(procs) ? fs.readdirSync(procs).filter((n) => n.endsWith(".json")) : []) {
    try { killTree(JSON.parse(fs.readFileSync(path.join(procs, f), "utf8")).pid); } catch { /* файл держателя дописывают */ }
  }
}
