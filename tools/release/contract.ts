// Контракт release: формат выпуска в бакете switchboard-releases — один владелец для CI, Worker'а «Выпусков» и модуля Host parts.
// Импорт отсюда — с "release.format@release": 1 в uses.
//
//   <часть>/<версия>.tgz      архив; у модуля каталога module.json — первая запись, у Worker'а и оболочки страницы в нём workers — имя Worker'а по флотам
//   <часть>/<версия>.sha256   «<sha256 архива>  <версия>.tgz»; пишется вторым — версия готова
// Модуль страницы — module.json и один ES-файл (WEB_FILE). Список сборки (BuildList, BUILD_FILE) — один для Host и страниц.
export { entries, manifestOf, MANIFEST, pack } from "./src/tar.ts";
export type { TarEntry, TarFile } from "./src/tar.ts";
export { presign, sha256hex, shaLine } from "./src/sign.ts";
export type { LinkKey } from "./src/sign.ts";
export { lf, packageFiles, packModule } from "./src/folder.ts";
export type { ModuleJson, PackedModule } from "./src/folder.ts";
export { differs, download, refused, upload } from "./src/transfer.ts";
export type { Answer, Net } from "./src/transfer.ts";
export { BUILD_FILE, hostBuild, WEB_FILE, webBuild } from "./src/build.ts";
export type { BuildList } from "./src/build.ts";
