// Контракт модуля Host points v1: точки сессий с пометкой «в R2» и подъём сессий из точек.
//   points.save { callsign, stop?, interrupt? } → { point, same }
//   points.raise { machine, sid, point, copy?, dir, slot?, profile?, name?, files: "point" | "keep", dryRun? }
//     → { callsign, point, folder, branch };  dryRun → { folder, files, branch, sessions }
//   session.r2 { callsign, on } → { point } (поставили — первая точка) | { deleted } (сняли — столько точек ушло из R2)
//   поле roster r2: нет — без пометки; {} — помечена; { error, at } — последняя точка не удалась
// Слова: not_r2, waiting, running, bad_point, bad_dir; чужие — как есть (not_owner, open_failed, name_taken, offline).
import { refuse } from "@switchboard/host";
import type { Module } from "@switchboard/host";

const gone = () => {
  throw refuse("снесено", "модуль точек написан заново");
};
export type PointFile = { p: string; size: number; b: string[] };
export type GitSummary = { state: "clean" | "dirty"; files: number; unpushed: number; url: string; branch: string; commit: string; snap?: string };
const module: Module = { requests: { "points.save": gone, "points.raise": gone, "session.r2": gone }, fields: { r2: () => undefined } };
export default module;
