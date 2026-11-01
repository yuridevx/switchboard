// Контракт release: формат выпуска частей машины в бакете switchboard-releases — пакет пишет его (switchboard release).
// Импорт отсюда — с "release.format@release": 1 в uses.
//
//   <часть>/<версия>.tgz      архив части: у Host — папка выпуска с app.json, у keeper — windows-amd64/keeper.exe и linux-amd64/keeper
//   <часть>/<версия>.sha256   «<sha256 архива>  <версия>.tgz»; пишется вторым — версия готова
export { parseSha, RELEASES_BUCKET, sha256hex, shaKey, shaLine, tgzKey, VERSION_RE } from "./src/format.ts";
export { entries, pack, unpack } from "./src/tar.ts";
export type { TarFile } from "./src/tar.ts";
export { s3, sign } from "./src/s3.ts";
export type { Fetch, S3Creds, S3Result } from "./src/s3.ts";
export { npmCli, runNode, runNpm } from "./src/run.ts";
export type { RunResult } from "./src/run.ts";
export { parseCheck } from "./src/build.ts";
