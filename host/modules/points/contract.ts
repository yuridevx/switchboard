// Контракт модуля Host points v1: точки сессий с пометкой «в архиве» и подъём сессий из точек.
//   points.save { callsign, stop?, interrupt? } → { point, same }
//   points.raise { machine, sid, point, copy?, dir, slot?, profile?: [id], name?, files: "point" | "keep", dryRun? }
//     → { callsign, point, folder, branch };  dryRun → { folder, files, branch, sessions }
//   session.archive { callsign, on } → { point } (поставили — первая точка; файла разговора ещё нет — null, точка на первом конце хода) | { deleted } (сняли — столько точек ушло из архива)
//   поле roster archive: нет — без пометки; {} — в архиве; { error, at } — последняя точка не удалась
// Точка несёт сводку сессии: заголовок (getSessionInfo SDK), модель последнего ответа и токены основной нити. Блоки файла разговора режутся по переводу строки.
// Слова: not_archived, store_failed, waiting, running, bad_point, bad_dir, has_wing — перенос ведущего пары на другую машину, отказ уже на пробе; чужие — как есть (not_owner, open_failed, name_taken, offline).
import { make } from "./src/module.ts";

export default make();
