// Контракт release: формат выпуска Host в бакете switchboard-releases — один пакет пишет (switchboard release)
// и читает (модуль host-upgrade). Импорт отсюда — с "release.format@release": 1 в uses.
//
//   host/<версия>.tgz      архив папки выпуска (tar в gzip): ядро и пакеты модулей, package.json, package-lock.json
//   host/<версия>.sha256   «<sha256 архива>  <версия>.tgz»
//   host/latest            последняя выложенная версия; пишется последней
export { latestKey, parseSha, RELEASES_BUCKET, sha256hex, shaKey, shaLine, tgzKey, VERSION_RE } from "./src/format.ts";
export { entries, pack, unpack } from "./src/tar.ts";
export type { TarFile } from "./src/tar.ts";
export { s3, sign } from "./src/s3.ts";
export type { Fetch, S3Creds, S3Result } from "./src/s3.ts";
export { npmCli, runNode, runNpm } from "./src/run.ts";
export type { RunResult } from "./src/run.ts";
export { parseCheck } from "./src/build.ts";
