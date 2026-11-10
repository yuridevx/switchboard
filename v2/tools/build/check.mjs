// Сверка «в дереве то же, что загружено под этим номером»: node tools/build/check.mjs <флот> [номер сборки] [устройство]
// Номер не назван — сверяется сборка, стоящая на флоте. Отпечаток считается из дерева так же, как при сборке (tools/build/digest.mjs).
// Выход: 0 — то же; 1 — код в дереве другой (нужна новая сборка); 2 — у сборки нет отпечатка или её нет в каталоге.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { digest } from "./digest.mjs";
import { fleetEnv } from "../dev.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const [fleet, num, device = "cli"] = process.argv.slice(2);
if (!fleet) throw new Error("нужно: <флот> [номер сборки] [устройство]");
const dir = path.join(os.homedir(), ".switchboard-dev");
const env = fleetEnv;
const key = fs.readFileSync(path.join(dir, `v2-${fleet}-${device}.pass`), "utf8").trim();
const res = await fetch(env.SB2_BASE + "/call", { method: "POST", headers: { authorization: "Bearer " + key, "content-type": "application/json" }, body: JSON.stringify({ type: "builds.list", id: "check" }) });
const reply = await res.json();
if (!reply.ok) throw new Error("builds.list: " + reply.error + " " + (reply.why ?? ""));
const build = num ? Number(num) : reply.result.stable;
const b = reply.result.builds.find((x) => x.build === build);
const mine = await digest(root);
if (!b) {
  console.log(`сборки ${build} нет в каталоге флота ${fleet}; отпечаток дерева ${mine.slice(0, 12)}`);
  process.exit(2);
}
if (!b.digest) {
  console.log(`у сборки ${build} нет отпечатка (загружена до его появления); отпечаток дерева ${mine.slice(0, 12)}`);
  process.exit(2);
}
const same = b.digest === mine;
console.log(same ? `сборка ${build}: в дереве то же, что загружено (${mine.slice(0, 12)})` : `сборка ${build}: код в дереве другой — загружено ${b.digest.slice(0, 12)}, в дереве ${mine.slice(0, 12)}; нужна новая сборка`);
process.exit(same ? 0 : 1);
