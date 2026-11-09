// Контракт pointfiles — точка сессии и файлы на диске, один пакет для подъёма Host и для switchboard pull.
//   snapshot(cwd) — сводка git папки и пакет того, чего нет на remote; folderOf(dir, git, sessions) — что будет с папкой подъёма;
//   bring(dir, git, folder, bundle) — ветка точки в папке; download(files, links) — блоки по ссылкам GET, SHA-256 сверен;
//   writeFiles(target, files, sid, source), setAside(claude, sid, target), projectDirOf(claude, cwd) — разговор в папке проекта Claude;
//   pull(argv, env) — команда switchboard pull <callsign | sid> [--point N] [--dir путь]: пропуск устройства и адрес points из окружения.
// Отказ — Refused со словом: bad_point, bad_dir, store_failed, no_point, no_links, timeout.
export { BUNDLE, bring, folderOf, snapshot, type Folder, type Summary } from "./src/git.ts";
export { download, projectDirOf, setAside, sha256, writeFiles, type PointFile } from "./src/lay.ts";
export { pull, PULL_USAGE } from "./src/pull.ts";
export { Refused } from "./src/refused.ts";
