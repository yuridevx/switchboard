// npm run gate: монорепо вокруг этого файла годно — выход 0 и строка с числами; иначе выход 1 и причины.
import { fileURLToPath } from "node:url";
import { check, loadRepo } from "./contract.ts";

const mods = loadRepo(fileURLToPath(new URL("../..", import.meta.url)));
const bad = check(mods);
if (bad.length) {
  console.error(`gate: ${bad.length} нарушений\n${bad.join("\n")}`);
  process.exit(1);
}
const names = mods.reduce((n, m) => n + Object.keys(m.provides).length, 0);
console.log(`gate: ok · ${mods.length} модулей · ${names} имён контракта`);
