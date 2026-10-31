// Гейт монорепо: до сборки модулей. Нарушено правило — выход 1 с причинами.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { check, loadRepo } from "./contract.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const mods = loadRepo(root);
const errors = check(mods);
if (errors.length) {
  console.error(`gate: ${errors.length} нарушений\n` + errors.join("\n"));
  process.exit(1);
}
const names = mods.reduce((n, m) => n + Object.keys(m.provides).length, 0);
console.log(`gate: ok · ${mods.length} модулей · ${names} имён контракта`);
