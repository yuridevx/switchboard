// Выгрузить сессию архива на этот компьютер без Host: node tools/fleet/pull.ts <флот> <устройство> <сессия архива> <папка> [точка]
// Папка получает репозиторий точки (клон или ветка точки), разговор встаёт в папку Claude этого компьютера: дальше — `claude --resume <сессия>` в папке.
// Те же функции, что у подъёма сессии на машине: блоки по ссылкам со сверкой, проверка папки, запись файлов.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApi, httpTransport, pointsGet } from "@sb/protocol";
import { download, writeFiles } from "../../host/src/modules/points/files.ts";
import { bring, BUNDLE, folderOf, type Summary } from "../../host/src/modules/points/git.ts";
import { projectDir } from "../../host/src/modules/points/points.ts";
import { fleetEnv } from "../dev.mjs";

const secrets = path.join(os.homedir(), ".switchboard-dev");
const env = fleetEnv;
const [fleet, device, sid, where, point] = process.argv.slice(2);
if (!fleet || !device || !sid || !where) throw new Error("нужно: <флот> <устройство> <сессия архива> <папка> [точка]");
const key = fs.readFileSync(path.join(secrets, `v2-${fleet}-${device}.pass`), "utf8").trim();
// разговор кладётся в папку Claude этого компьютера
process.env.CLAUDE_CONFIG_DIR ??= path.join(os.homedir(), ".claude");

const api = createApi(httpTransport({ base: env.SB2_BASE!, key }));
const got = await api.call(pointsGet, { sid, ...(point ? { point } : {}) });
const dir = path.resolve(where);
const git = got.point.git ? (JSON.parse(got.point.git) as Summary) : undefined;
const check = await folderOf(dir, git, []);
if (check.folder === "other") throw new Error(`${dir}: в папке другой репозиторий — выберите другую`);
const files = await download(got.files);
const branch = git && (check.folder === "empty" || check.folder === "same") ? await bring(dir, git, check.folder, files.get(BUNDLE)) : null;
fs.mkdirSync(dir, { recursive: true });
const written = writeFiles(projectDir(dir), files, [BUNDLE]);
console.log(`сессия ${got.session.callsign}, точка ${got.point.point}: файлов разговора ${written.length}; папка ${dir} — ${check.folder}${branch ? `, ветка ${branch}` : ""}${check.folder === "dirty" ? ", правки в папке не тронуты" : ""}`);
console.log(`дальше: cd "${dir}" && claude --resume ${sid}`);
