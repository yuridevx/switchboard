// Контракт модуля Host points v1: точки сессий с пометкой «в R2» и подъём сессий из точек.
//   points.save { callsign, stop?, interrupt? } → { point, same }
//   points.raise { machine, sid, point, copy?, dir, slot?, profile?, name?, files: "point" | "keep", dryRun? }
//     → { callsign, point, folder, branch };  dryRun → { folder, files, branch, sessions }
//   session.r2 { callsign, on } → { point } (поставили — первая точка; файла разговора ещё нет — null, точка на первом конце хода) | { deleted } (сняли — столько точек ушло из R2)
//   поле roster r2: нет — без пометки; {} — помечена; { error, at } — последняя точка не удалась
// Слова: not_r2, waiting, running, bad_point, bad_dir; чужие — как есть (not_owner, open_failed, name_taken, offline).
import { make } from "./src/module.ts";

export default make();
