// Контракт release: формат выпуска частей машины в бакете switchboard-releases — один владелец для CI (switchboard
// release), Worker «выпуски» (ключи, хэш, подписанные ссылки) и модуля Host «части» (упаковка папки приложения).
// Импорт отсюда — с "release.format@release": 1 в uses.
//
//   <часть>/<версия>.tgz      архив части: у Host — папка выпуска с app.json, у keeper — windows-amd64/keeper.exe и linux-amd64/keeper
//   <часть>/<версия>.sha256   «<sha256 архива>  <версия>.tgz»; пишется вторым — версия готова
// Каталог модулей — та же раскладка: <модуль>/<версия>.tgz, module.json — первой записью архива; у Worker'а и оболочки
// страницы в нём workers — имя Worker'а по флотам. Модуль страницы — module.json и один ES-файл (WEB_FILE);
// сборка страницы — раскладка webBuild: оболочка в корне, m/<модуль>.js, build.json. Список сборки (BuildList,
// buildFile) — один для Host и страниц: модули и адреса Worker'ов флота.
export { parseSha, RELEASES_BUCKET, shaKey, shaLine, tgzKey, VERSION_RE } from "./src/format.ts";
export { presign } from "./src/presign.ts";
export type { LinkKey } from "./src/presign.ts";
export { sha256hex } from "./src/hash.ts";
export { entries, manifestOf, MANIFEST, pack } from "./src/tar.ts";
export type { TarFile } from "./src/tar.ts";
// упаковка модуля из папки по module.json — монорепо (release-cli) и чужой репо (parts.upload)
export { packageFiles, packModule } from "./src/pack.ts";
export type { ModuleJson, PackedModule } from "./src/pack.ts";
export { upload, PUT_MS } from "./src/upload.ts";
export type { FetchReply, Get, Put, UploadReply } from "./src/upload.ts";
export { WEB_FILE, webBuild } from "./src/web.ts";
export { importMap, withImportMap } from "./src/importmap.ts";
export { BUILD_FILE, buildFile } from "./src/build-list.ts";
export type { BuildList } from "./src/build-list.ts";
