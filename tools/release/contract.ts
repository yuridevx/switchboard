// Контракт release: формат выпуска частей машины в бакете switchboard-releases — один владелец для CI (switchboard
// release), Worker «выпуски» (ключи, хэш, подписанные ссылки) и модуля Host «части» (упаковка папки приложения).
// Импорт отсюда — с "release.format@release": 1 в uses.
//
//   <часть>/<версия>.tgz      архив части: у Host — папка выпуска с app.json, у keeper — windows-amd64/keeper.exe и linux-amd64/keeper
//   <часть>/<версия>.sha256   «<sha256 архива>  <версия>.tgz»; пишется вторым — версия готова
// Каталог модулей — та же раскладка: <модуль>/<версия>.tgz, module.json — первой записью архива; у Worker'а и оболочки
// страницы в нём workers — имя Worker'а по флотам.
export { parseSha, RELEASES_BUCKET, shaKey, shaLine, tgzKey, VERSION_RE } from "./src/format.ts";
export { presign } from "./src/presign.ts";
export type { LinkKey } from "./src/presign.ts";
export { sha256hex } from "./src/hash.ts";
export { entries, manifestOf, MANIFEST, pack, packDir } from "./src/tar.ts";
export { upload, PUT_MS } from "./src/upload.ts";
export type { Put, UploadReply } from "./src/upload.ts";
// упаковка частей из монорепо — для CLI выпуска
export { build } from "./src/build.ts";
export type { Exec } from "./src/build.ts";
export { buildKeeper, runGo } from "./src/keeper.ts";
export type { GoExec } from "./src/keeper.ts";
export { packModule } from "./src/module.ts";
export { runNode, runNpm } from "./src/run.ts";
