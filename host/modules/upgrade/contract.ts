// Контракт модуля Host upgrade v1: новая версия Host из выпусков в R2.
//   machine.upgrade { machine, version: "1.4.1" | "latest", dryRun? }
//     → { from, to, sdk: { from, to }, restart, modules? }   restart — заменяется ли процесс Host
//     dryRun → { from, to }: какая работает и какая встанет; архив не скачивается
//   в журнал флота — ledger.add machine.upgraded
// Слова: bad_frame, already_current, upgrade_running, no_release, download_failed, check_failed;
// от ядра — module_error, shutting_down.
import { upgrade } from "./src/upgrade.ts";

export default upgrade();
