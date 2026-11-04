// Контракт release: формат выпуска в бакете switchboard-releases — один владелец для CI, Worker'а «Выпусков» и модуля Host parts.
// Импорт отсюда — с "release.format@release": 1 в uses.
//
//   <часть>/<версия>.tgz      архив; у модуля каталога module.json — первая запись, у Worker'а и оболочки страницы в нём workers — имя Worker'а по флотам
//   <часть>/<версия>.sha256   «<sha256 архива>  <версия>.tgz»; пишется вторым — версия готова
// Модуль страницы — module.json и один ES-файл (WEB_FILE). Список сборки (BuildList, buildFile) — один для Host и страниц.
export { entries, manifestOf, MANIFEST, pack } from "./src/archive.ts";
export type { TarEntry, TarFile } from "./src/archive.ts";
export { byVersion, isBuild, isVersion, parseSha, RELEASES_BUCKET, sha256hex, shaKey, shaLine, tgzKey } from "./src/layout.ts";
export { presign } from "./src/link.ts";
export type { LinkKey } from "./src/link.ts";
export { packageFiles, packModule } from "./src/folder.ts";
export type { ModuleJson, PackedModule } from "./src/folder.ts";
export { download, upload } from "./src/transfer.ts";
export type { Answer, FetchReply, Net, UploadReply } from "./src/transfer.ts";
export { BUILD_FILE, buildFile, WEB_FILE, webBuild } from "./src/page.ts";
export type { BuildList } from "./src/page.ts";
