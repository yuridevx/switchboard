// Дома слопиков в Switchboard: модули с манифестом.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRepo } from "../../../../tools/manifest-gate/contract.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
console.log(JSON.stringify(loadRepo(root).map((m) => ({ name: m.name, dir: `${m.dir.replaceAll("\\", "/")}/` }))));
