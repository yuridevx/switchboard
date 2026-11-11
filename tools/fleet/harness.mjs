// Общая обвязка живых сценариев: настоящий Chrome и запрос флоту пропуском устройства.
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const { chromium } = createRequire(path.join(root, "package.json"))("playwright-core");

/** Запросы флоту от устройства: call — ответ целиком; must — результат или ошибка со словом отказа.
 *  Сеть машины разработки моргает: запрос, не дошедший до флота (offline), повторяется до пяти раз. */
export function fleetCall(fleet, device) {
  const call = (type, fields = {}) => {
    for (let i = 0; ; i++) {
      let r;
      try {
        r = JSON.parse(execFileSync(process.execPath, [path.join(root, "tools/fleet/call.ts"), fleet, device, type, JSON.stringify(fields)], { cwd: root, stdio: ["ignore", "pipe", "pipe"] }).toString());
      } catch (e) {
        r = JSON.parse(e.stdout.toString());
      }
      if (r.ok || r.error !== "offline" || i >= 4) return r;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000);
    }
  };
  const must = (type, fields) => {
    const r = call(type, fields);
    if (!r.ok) throw new Error(`${type}: ${r.error} ${r.why ?? ""}`);
    return r.result;
  };
  return { call, must };
}
