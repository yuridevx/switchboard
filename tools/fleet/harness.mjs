// Общая обвязка живых сценариев: настоящий Chrome и запрос флоту пропуском устройства.
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const { chromium } = createRequire(path.join(root, "package.json"))("playwright-core");

/** Метка проверки для имён её сессий, папок и устройств. Случайная: проверки списка стартуют разом, метка из часов у них совпадала. */
export const newTag = () => crypto.randomBytes(3).toString("hex");

/** Чего у флота нет — список в SB2_WITHOUT через пробел. Флот в коробке (tools/box/box.mjs) называет им то, чего на одном компьютере не бывает:
 *  mind — модель, которая понимает прочитанное; claude — аккаунты Claude; clickhouse — история флота; r2 — подписанные ссылки хранилища;
 *  push — уведомления браузера; github — репозитории кусочков и проектов; keeper — служба машины со сборками Host.
 *  Шаг или проверка, которым это нужно, на таком флоте не идут. */
export const lacks = (what) => (process.env.SB2_WITHOUT ?? "").split(" ").includes(what);

/** Временная папка машины глазами самой машины: проверка идёт с любого компьютера, в том числе с раннера CI. */
export function machineTmp(fleet, device, machine) {
  const run = fleetCall(fleet, device).must("shell.run", { to: "@" + machine, shell: "node", script: 'import os from "node:os";process.stdout.write(os.tmpdir())', wait: 30 });
  return String(run.out).trim().replaceAll("\\", "/");
}

/** Файл в хранилище флота по хэшу содержимого. Ответ — запись {name, hash, size} для поля files сообщения. */
export async function putFile(fleet, device, name, bytes) {
  const hash = crypto.createHash("sha256").update(bytes).digest("hex");
  const link = fleetCall(fleet, device).must("files.put", { files: [{ hash, size: bytes.length }] }).upload[hash];
  // ссылки нет — такое содержимое в хранилище уже лежит
  if (link) {
    const put = await fetch(link, { method: "PUT", body: bytes, signal: AbortSignal.timeout(60_000) });
    if (!put.ok) throw new Error(`загрузка ${name}: HTTP ${put.status}`);
  }
  return { name, hash, size: bytes.length };
}

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
