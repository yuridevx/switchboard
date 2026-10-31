// Контракт модуля Host chat: человек пишет сессии. Версия 1; запросы адресованы callsign сессии.
//   session.prompt { callsign, uuid?, text, attachments?: [{ name, media_type, data(base64) }] } → { uuid }
//   session.history { callsign, before: uuid | null, limit } → { messages: SessionMessage[], more }
//   session.files { callsign, query, limit } → ["src/worker.ts", …] — пути от папки сессии
// Слова: bad_attachment — у типа вложения нет блока; stopped — сессия остановлена (поднимает session.start).
import { make } from "./src/chat.ts";

export type { Attachment } from "./src/chat.ts";
export default make();
